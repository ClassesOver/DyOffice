import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'
test('Sheets bridge preserves its original save across lost receipts and metadata retries',{timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-bridge-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const outfile=join(dir,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge}=await import(pathToFileURL(outfile).href)
 const native=createXlsxNativeWorker(await sandboxFixture('native')),{planWorkbookSave,readWorkbookPackage}=await sheetsGateway(t)
 const f=await fileFixture(t,{sheetsNative:native,sheetsPlanner:planWorkbookSave,sheetsPackageReader:readWorkbookPackage})
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const initial=(await importFile(f,f.alice.token,bytes,'acceptance.xlsx')).file
 const address=await f.app.listen({port:0,host:'127.0.0.1'})
 let drop=true,preparations=0,failReopen=true,committed=false
 const fetchImpl=async(path,init={})=>{
  if(path.endsWith('/sheets/uploads'))preparations++
  if(path.endsWith('/sheets/inspect')&&committed&&failReopen){failReopen=false;return new Response('{}',{status:503,headers:{'content-type':'application/json'}})}
  const response=await fetch(address+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),origin:'https://office.example',cookie:'__Host-dyoffice-session='+f.alice.token}})
  if(path.endsWith('/commits')&&drop){committed=true;drop=false;await response.arrayBuffer();throw new TypeError('lost commit response')}
  return response
 }
 const host=createSessionFileHost({fetchImpl});t.after(()=>host.dispose())
 await host.open(initial.fileId);await host.acquireLease(initial.fileId)
 const bridge=createSheetsBridge(host,initial.fileId,await host.getPreferences(),{fetchImpl});t.after(()=>bridge.dispose())
 const file=await bridge.api.selectWorkbook()
 assert.equal(file.name,'acceptance.xlsx');assert.equal(file.sha256,initial.sha256)
 assert.equal(file.path,undefined)
 const request={sessionId:file.sessionId,sheetId:file.sheets[0].id,range:{startRow:1,endRow:1,startColumn:0,endColumn:5}}
 const range=await bridge.api.readWorkbookRange(request)
 assert.equal(range.cells.find(c=>c.column===0).value,12.5)
 const calculated=await bridge.api.recalcWorkbook({sessionId:file.sessionId,edits:[],reads:[{sheetId:file.sheets[0].id,range:{startRow:1,endRow:1,startColumn:1,endColumn:1}}]})
 assert.equal(calculated.cells[0].number,25);assert.equal(calculated.cells[0].sheetId,file.sheets[0].id)
 assert.equal((await bridge.api.readWorkbookRedactions({sessionId:file.sessionId})).status,'absent')
 const edits={...sheetsSaveRequest(file.sheets[0].id,[{row:1,column:0,writeValue:true,value:32}]),sessionId:file.sessionId}
const saving=bridge.api.saveWorkbookEdits(edits)
 let settled=false;saving.then(()=>{settled=true},()=>{settled=true})
 const deadline=Date.now()+10000
 while(!bridge.needsConfirmation()) {assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,20))}
 assert.equal(settled,false,'original renderer save must retain its snapshot until confirmation')
 await assert.rejects(()=>bridge.confirmSave())
 assert.equal(bridge.needsConfirmation(),true,'metadata retry must retain a known committed save')
 assert.equal(settled,false)
 await bridge.confirmSave()
 const saved=await saving
 assert.equal(preparations,1,'confirmation must not replay edits')
 assert.equal(saved.canceled,false);assert.notEqual(saved.file.sha256,file.sha256)
 assert.ok(saved.touchedEntries.includes('xl/worksheets/sheet1.xml'))
 await bridge.api.closeWorkbook(file.sessionId)
 await assert.rejects(()=>bridge.api.readWorkbookRange(request))
 const reopened=await bridge.api.readWorkbookRange({...request,sessionId:saved.file.sessionId,sheetId:saved.file.sheets[0].id})
 assert.equal(reopened.cells.find(c=>c.column===0).value,32)
})


test('unsupported workbook operations reject asynchronously instead of breaking original renderer load', async t => {
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-capabilities-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const outfile=join(dir,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge}=await import(pathToFileURL(outfile).href)
 const bridge=createSheetsBridge({},'unused',{language:'en',theme:'light'})
 t.after(()=>bridge.dispose())
 for(const method of ['readPivotDefinition','findWorkbookCells','updateWorkbookPassword','readExternalLinkUsage','listWorkbookTabs']){
  assert.equal(typeof bridge.api[method],'function',method)
  let operation
  assert.doesNotThrow(()=>{operation=bridge.api[method]({})},method)
  await assert.rejects(operation,error=>error.message.length>0&&!/is not a function/.test(error.message))
 }
})
