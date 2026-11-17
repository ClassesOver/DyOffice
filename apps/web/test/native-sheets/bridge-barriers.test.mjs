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
 let head=initial,epoch=1,preparations=0,commits=0
 const lease=()=>({leaseEpoch:epoch,editorId,expiresAt:new Date(Date.now()+60000).toISOString()})
 const fetchImpl=async(path,init={})=>{
  const handled=await intercept(path,init,{saved,setHead:value=>{head=value}});if(handled)return handled
  if(path.endsWith('/csrf'))return json({csrfToken:'a'.repeat(43)})
  if(path.endsWith('/lease')&&!init.method)return json({...lease(),active:true})
  if(path.endsWith('/takeover')){epoch++;return json(lease())}
  if(path.includes('/lease'))return json(lease())
  if(path.endsWith('/sheets/inspect'))return json(metadata)
  if(path.endsWith('/sheets/uploads')){preparations++;return json({uploadId:randomUUID(),baseRevision:head.revision,leaseEpoch:epoch,sha256:saved.sha256,size:saved.size,touchedEntries:['xl/worksheets/sheet1.xml']})}
  if(path.endsWith('/commits')){commits++;head=saved;return json(saved)}
  if(path===`/api/v1/files/${fileId}`)return json({file:head,format:'xlsx',name:'test.xlsx',capabilities:{docx:'editable',xlsx:'editable',pptx:'read_only',pdf:'read_only'},downloadEndpoint:`/api/v1/files/${fileId}/content?revision=${head.revision}`})
  throw new Error(`Unexpected fetch ${path}`)
 }
 const host=createSessionFileHost({fetchImpl,editorId,leaseRetryDelayMs:0});t.after(()=>host.dispose())
 await host.open(fileId);await host.acquireLease(fileId)
 const changes=new Set()
 const bridge=createSheetsBridge(host,fileId,{language:'en',theme:'light'},{fetchImpl,onChange:()=>{for(const listener of changes)listener()}});t.after(()=>bridge.dispose())
 const waitForConfirmation=()=>new Promise(resolve=>{const listener=()=>{if(bridge.needsConfirmation()){changes.delete(listener);resolve()}};changes.add(listener);listener()})
 return {host,bridge,fileId,initial,saved,fetchImpl,waitForConfirmation,counts:()=>({preparations,commits})}
}

test('download waits for the existing save, active cell commit and late edits before pinning revision',async t=>{
 const gate=barrier(),f=await fixture(t,async(path)=>{if(path.endsWith('/commits')){gate.enter();await gate.gate}})
 const file=await f.bridge.api.selectWorkbook()
 let dirty=true,finishedCell=false
 const editor={isDirty:()=>dirty,async saveAndWait(){finishedCell=true;await f.bridge.api.saveWorkbookEdits({...sheetsSaveRequest(file.sheets[0].id,[{row:0,column:0,writeValue:true,value:42}]),sessionId:file.sessionId});dirty=false;f.bridge.api.notifyPendingEdits(0);return true}}
 // The save queue is deliberately held open. Download must not return the old head.
 let settled=false
 const downloading=f.bridge.prepareDownload(editor).then(value=>{settled=true;return value})
 await gate.entered;assert.equal(finishedCell,true);assert.equal(settled,false)
 gate.release();const result=await downloading
 assert.equal(result.revision,f.saved.revision);assert.notEqual(result.revision,f.initial.revision);assert.equal(dirty,false)
})

test('unknown save keeps download pending until confirmation returns the same receipt',async t=>{
 const commit=barrier();let lose=true
 const f=await fixture(t,async(path,init,{saved,setHead})=>{
  if(path.endsWith('/commits')&&lose){lose=false;setHead(saved);commit.enter();await commit.gate;throw new TypeError('lost commit receipt')}
 })
 const file=await f.bridge.api.selectWorkbook()
 const saving=f.bridge.api.saveWorkbookEdits({...sheetsSaveRequest(file.sheets[0].id,[{row:0,column:0,writeValue:true,value:42}]),sessionId:file.sessionId})
 let dirty=true,settled=false
 f.bridge.api.notifyPendingEdits(1)
 const editor={isDirty:()=>dirty,async saveAndWait(){await saving;dirty=false;f.bridge.api.notifyPendingEdits(0);return true}}
 const downloading=f.bridge.prepareDownload(editor).then(value=>{settled=true;return value})
 await commit.entered;assert.equal(settled,false);commit.release()
 await f.waitForConfirmation()
 assert.equal(f.host.getState(f.fileId).status,'unknown');assert.equal(settled,false)
 await f.bridge.confirmSave()
 const result=await downloading
 assert.equal(result.revision,f.saved.revision);assert.notEqual(result.revision,f.initial.revision)
 assert.equal(f.counts().preparations,1)
})

test('a stale React pending-edits notification cannot veto a fully acknowledged download',async t=>{
 const f=await fixture(t)
 f.bridge.api.notifyPendingEdits(1)
 const result=await f.bridge.prepareDownload({isDirty:()=>false,saveAndWait:async()=>true})
 assert.equal(result.revision,f.initial.revision)
})

test('known commit metadata failure retains the save and exact receipt through retry',async t=>{
 let committed=false,failInspect=true
 const f=await fixture(t,(path)=>{
  if(path.endsWith('/commits'))committed=true
  if(path.endsWith('/sheets/inspect')&&committed&&failInspect){failInspect=false;return json({},503)}
 })
 const file=await f.bridge.api.selectWorkbook()
 const saving=f.bridge.api.saveWorkbookEdits({...sheetsSaveRequest(file.sheets[0].id,[{row:0,column:0,writeValue:true,value:42}]),sessionId:file.sessionId})
 let settled=false;saving.then(()=>{settled=true},()=>{settled=true})
 await f.waitForConfirmation()
 assert.equal(settled,false);assert.equal(f.host.getState(f.fileId).revision.revision,f.saved.revision)
 await f.bridge.confirmSave();const saved=await saving
 assert.equal(saved.file.sha256,f.saved.sha256);assert.equal(f.counts().preparations,1);assert.equal(f.counts().commits,1)
})

test('renewal preserves unknown save state and refresh refuses to discard its receipt',async t=>{
 const f=await fixture(t,(path)=>{if(path.endsWith('/commits'))throw new TypeError('lost receipt')})
 await assert.rejects(f.host.saveSheets(f.fileId,{}),{code:'UNAVAILABLE'})
 await f.host.renewLease(f.fileId)
 assert.equal(f.host.getState(f.fileId).status,'unknown')
 await assert.rejects(f.host.refreshHead(f.fileId),{code:'UNAVAILABLE'})
 assert.equal(f.host.getState(f.fileId).revision.revision,f.initial.revision)
})

test('download fails closed when late edits survive a successful save',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.bridge.prepareDownload({isDirty:()=>true,saveAndWait:async()=>true}),{code:'CONFLICT'})
})

test('download fails closed on a failed save and lost editing authority',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.bridge.prepareDownload({isDirty:()=>false,saveAndWait:async()=>false}))
 await f.host.releaseLease(f.fileId)
 let called=false
 await assert.rejects(f.bridge.prepareDownload({isDirty:()=>false,saveAndWait:async()=>{called=true;return true}}),{code:'CONFLICT'})
 assert.equal(called,false)
})

test('clean takeover refreshes the head before reloading and dirty takeover preserves the view',async t=>{
 const gate=barrier(),f=await fixture(t,async(path,init,{saved,setHead})=>{
  if(path.endsWith('/takeover')){setHead(saved);gate.enter();await gate.gate}
 })
 let reloaded=false
 const editor={isDirty:()=>false,async reload(){assert.equal(f.host.getState(f.fileId).revision.revision,f.saved.revision);reloaded=true;return true}}
 const claiming=f.bridge.takeover(editor)
 await gate.entered;assert.equal(reloaded,false);gate.release();await claiming
 assert.equal(reloaded,true)
 let dirtyReloaded=false
 await assert.rejects(f.bridge.takeover({isDirty:()=>true,reload:async()=>{dirtyReloaded=true;return true}}),{code:'CONFLICT'})
 assert.equal(dirtyReloaded,false)
})

test('bridge refreshes an expired CSRF proof once and retries the pinned revision',async t=>{
 let csrf=0,inspects=0
 const f=await fixture(t,(path,init)=>{
  if(path.endsWith('/csrf')){csrf++;return json({csrfToken:(csrf===1?'a':'b').repeat(43)})}
  if(path.endsWith('/sheets/inspect')){inspects++;if(inspects===1)return json({},403)}
 })
 await f.bridge.api.selectWorkbook()
 assert.equal(inspects,2);assert.equal(csrf,3)
})


test('guard revoked in native save queue or prepared upload never submits workbook commit',async t=>{
 for(const stage of ['queue','upload']){
  let authorized=true
  const f=await fixture(t,path=>{if(stage==='upload'&&path.endsWith('/sheets/uploads'))authorized=false})
  const file=await f.bridge.api.selectWorkbook()
  const saving=f.bridge.guardedSave(()=>authorized,async()=>{
   await Promise.resolve();if(stage==='queue')authorized=false
   await f.bridge.api.saveWorkbookEdits({...sheetsSaveRequest(file.sheets[0].id,[{row:0,column:0,writeValue:true,value:'=1+1'}]),sessionId:file.sessionId})
   return true
  })
  await assert.rejects(saving)
  assert.equal(f.counts().commits,0)
  if(stage==='queue')assert.equal(f.counts().preparations,0)
 }
})
