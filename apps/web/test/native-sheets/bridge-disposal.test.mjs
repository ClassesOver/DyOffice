import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {build} from 'esbuild'
import {createSessionFileHost} from '../../../../packages/browser-host/src/session-files.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'

let directory,createSheetsBridge
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'dyoffice-sheet-barriers-'))
 const outfile=join(directory,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 ;({createSheetsBridge}=await import(pathToFileURL(outfile).href))
})
after(()=>rm(directory,{recursive:true,force:true}))
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
function barrier(){let enter,release;return {entered:new Promise(r=>{enter=r}),gate:new Promise(r=>{release=r}),enter:()=>enter(),release:()=>release()}}
const metadata={entryCount:1,sheets:[{id:'1',name:'Sheet1',rowCount:10,columnCount:10,columnWidths:[],defaultRowHeight:null,defaultColumnWidth:null,freeze:null,hidden:false,tabColor:null,showGridLines:true,tables:[],comments:[],pivotRanges:[]}],styles:[],dxfStyles:[],visuals:[],definedNames:[]}
async function fixture(t,intercept=()=>undefined){
 const fileId=randomUUID(),editorId=randomUUID(),initial={fileId,revision:randomUUID(),sha256:'a'.repeat(64),size:10},saved={...initial,revision:randomUUID(),sha256:'b'.repeat(64)}
 let head=initial,epoch=1,preparations=0,commits=0;const commitInputs=[]
 const lease=()=>({leaseEpoch:epoch,editorId,expiresAt:new Date(Date.now()+60000).toISOString()})
 const fetchImpl=async(path,init={})=>{
  if(path.endsWith('/commits')){commits++;commitInputs.push(JSON.parse(init.body))}
  const handled=await intercept(path,init,{head,saved,setHead:value=>{head=value}});if(handled)return handled
  if(path.endsWith('/csrf'))return json({csrfToken:'a'.repeat(43)})
  if(path.endsWith('/lease')&&!init.method)return json({...lease(),active:true})
  if(path.endsWith('/takeover')){epoch++;return json(lease())}
  if(path.includes('/lease'))return json(lease())
  if(path.endsWith('/sheets/inspect'))return json(metadata)
  if(path.endsWith('/sheets/uploads')){preparations++;return json({uploadId:randomUUID(),baseRevision:head.revision,leaseEpoch:epoch,sha256:saved.sha256,size:saved.size,touchedEntries:['xl/worksheets/sheet1.xml']})}
  if(path.endsWith('/commits')){head=saved;return json(saved)}
  if(path===`/api/v1/files/${fileId}`)return json({file:head,format:'xlsx',name:'test.xlsx',capabilities:{docx:'editable',xlsx:'editable',pptx:'read_only',pdf:'read_only'},downloadEndpoint:`/api/v1/files/${fileId}/content?revision=${head.revision}`})
  throw new Error(`Unexpected fetch ${path}`)
 }
 const host=createSessionFileHost({fetchImpl,editorId,leaseRetryDelayMs:0});t.after(()=>host.dispose())
 await host.open(fileId);await host.acquireLease(fileId)
 let notifications=0;const changes=new Set()
 const bridge=createSheetsBridge(host,fileId,{language:'en',theme:'light'},{fetchImpl,onChange:()=>{notifications++;for(const listener of changes)listener()}});t.after(()=>bridge.dispose())
 const waitForConfirmation=()=>new Promise(resolve=>{const listener=()=>{if(bridge.needsConfirmation()){changes.delete(listener);resolve()}};changes.add(listener);listener()})
 return {host,bridge,fileId,initial,saved,fetchImpl,waitForConfirmation,notifications:()=>notifications,counts:()=>({preparations,commits}),commitInputs}
}

test('a saved blank workbook adopts its confirmed name in the editor',async t=>{
 let fileName='未命名.xlsx'
 const f=await fixture(t,(path,init,{head,saved})=>{
  if(path.endsWith('/auto-name')){
   assert.equal(JSON.parse(init.body).revision,saved.revision)
   fileName='季度汇总.xlsx'
   return json({renamed:true,name:fileName})
  }
  if(path===`/api/v1/files/${head.fileId}`)return json({file:head,format:'xlsx',name:fileName,autoNamePending:fileName==='未命名.xlsx',capabilities:{docx:'editable',xlsx:'editable',pptx:'read_only',pdf:'read_only'},downloadEndpoint:path+'/content?revision='+head.revision})
 })
 const file=await f.bridge.api.selectWorkbook()
 assert.deepEqual(await f.bridge.api.autoRenameWorkbook(file.sessionId,'季度汇总'),{renamed:false})
 const changes=[]
 const unsubscribe=f.bridge.api.onWorkbookRenamed(name=>changes.push(name))
 t.after(unsubscribe)
 const saved=await f.bridge.api.saveWorkbookEdits({...sheetsSaveRequest(file.sheets[0].id,[{row:0,column:0,writeValue:true,value:42}]),sessionId:file.sessionId})
 await f.bridge.api.autoRenameWorkbook(saved.file.sessionId,'季度汇总')
 assert.deepEqual(changes,['季度汇总.xlsx'])
 assert.equal((await f.bridge.api.selectWorkbook()).name,'季度汇总.xlsx')
})

// A bounded timeout reports a leaked Promise; barriers, not sleeps, establish
// exactly which real bridge/host operation is in flight at teardown.
async function rejectedAfterTeardown(operation) {
 let timer
 try {
  const outcome=await Promise.race([
   operation.then(()=>({kind:'resolved'}),error=>({kind:'rejected',error})),
   new Promise(resolve=>{timer=setTimeout(()=>resolve({kind:'pending'}),500)}),
  ])
  assert.equal(outcome.kind,'rejected','a disposed editor must settle its original save, not recreate recovery')
  assert.equal(outcome.error.code,'UNAVAILABLE',String(outcome.error))
 } finally {clearTimeout(timer)}
}
for(const phase of ['commit-success','commit-unknown','metadata']) {
 test(`dispose during ${phase} does not resurrect a save recovery`,async t=>{
  const gate=barrier();let committed=false
  const f=await fixture(t,async(path,_init,{saved,setHead})=>{
   if(path.endsWith('/commits')) {
    if(phase!=='metadata'){gate.enter();await gate.gate}
    committed=true;setHead(saved)
    if(phase==='commit-unknown')throw new TypeError('lost commit acknowledgement')
    return json(saved)
   }
   if(path.endsWith('/sheets/inspect')&&committed){gate.enter();await gate.gate}
  })
  const file=await f.bridge.api.selectWorkbook()
  const saving=f.bridge.api.saveWorkbookEdits({...sheetsSaveRequest(file.sheets[0].id,[{row:0,column:0,writeValue:true,value:42}]),sessionId:file.sessionId})
  const settled=rejectedAfterTeardown(saving)
  await gate.entered
  f.bridge.dispose();gate.release()
  await settled
  assert.equal(f.bridge.needsConfirmation(),false)
  assert.equal(f.host.getState(f.fileId).status,phase==='commit-unknown'?'unknown':'idle','teardown does not rewrite the host commit outcome')
  await f.bridge.confirmSave()
  assert.equal(f.counts().preparations,1,'teardown must not retry a dispatched save')
  assert.equal(f.counts().commits,1)
 })
}

for(const phase of ['receipt','metadata']) {
 test(`dispose during confirmation ${phase} rejects the original save without late notifications`,async t=>{
  const gate=barrier();let confirming=false
  const f=await fixture(t,async(path,_init,{saved,setHead})=>{
   if(path.endsWith('/commits')){setHead(saved);if(!confirming)throw new TypeError('lost commit acknowledgement');if(phase==='receipt'){gate.enter();await gate.gate}return json(saved)}
   if(confirming&&phase==='metadata'&&path.endsWith('/sheets/inspect')){gate.enter();await gate.gate}
  })
  const file=await f.bridge.api.selectWorkbook()
  const saving=f.bridge.api.saveWorkbookEdits({...sheetsSaveRequest(file.sheets[0].id,[{row:0,column:0,writeValue:true,value:42}]),sessionId:file.sessionId})
  const settled=rejectedAfterTeardown(saving)
  await f.waitForConfirmation();confirming=true
  const confirmation=f.bridge.confirmSave()
  const confirmationSettled=rejectedAfterTeardown(confirmation)
  await gate.entered;f.bridge.dispose();const notifications=f.notifications();gate.release()
  await settled;await confirmationSettled
  assert.equal(f.bridge.needsConfirmation(),false)
  assert.equal(f.notifications(),notifications,'disposed bridge must not notify its old view')
  assert.equal(f.counts().preparations,1)
  assert.equal(f.counts().commits,2,'only the explicit confirmation retries the commit receipt')
  assert.deepEqual(f.commitInputs[1],f.commitInputs[0],'confirmation preserves the exact upload and idempotency key')
  assert.equal(f.host.getState(f.fileId).status,'idle','a confirmed host receipt remains committed')
 })
}
