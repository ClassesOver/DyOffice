import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'
test('Sheets BrowserHost reconciles a lost native-edit commit without generating another workbook',async t=>{
 const native=createXlsxNativeWorker(await sandboxFixture('native')),{planWorkbookSave}=await sheetsGateway(t)
 const f=await fileFixture(t,{sheetsNative:native,sheetsPlanner:planWorkbookSave})
 const bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const initial=(await importFile(f,f.alice.token,bytes,'acceptance.xlsx')).file
 const address=await f.app.listen({port:0,host:'127.0.0.1'})
 let lost=true,preparations=0,commits=[]
 const fetchImpl=async(path,init={})=>{
  if(path.endsWith('/sheets/uploads'))preparations++
  const reply=await fetch(address+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),origin:'https://office.example',cookie:'__Host-dyoffice-session='+f.alice.token}})
  if(path.endsWith('/commits')){
   commits.push(JSON.parse(init.body))
   if(lost){lost=false;await reply.arrayBuffer();throw new TypeError('controlled lost reply')}
  }
  return reply
 }
 const host=createSessionFileHost({fetchImpl});t.after(()=>host.dispose())
 await host.open(initial.fileId);await host.acquireLease(initial.fileId)
 const metadata=await native.inspect(bytes)
 const edits=sheetsSaveRequest(metadata.sheets[0].id,[{row:1,column:0,writeValue:true,value:26}])
 await assert.rejects(()=>host.saveSheets(initial.fileId,edits),{code:'UNAVAILABLE'})
 assert.equal(host.getState(initial.fileId).status,'unknown')
 await assert.rejects(()=>host.saveSheets(initial.fileId,edits),{code:'UNAVAILABLE'})
 assert.equal(preparations,1)
 const saved=await host.reconcile(initial.fileId)
 assert.deepEqual(commits[0],commits[1])
 assert.equal(saved.revision,(await f.files.openFile(f.alice.token,initial.fileId)).file.revision)
 const output=await host.readBytes(initial.fileId,saved.revision)
 const result=await native.readRange(output,'Acceptance',{startRow:1,endRow:1,startColumn:0,endColumn:0})
 assert.equal(result.cells[0].value,26)
})
