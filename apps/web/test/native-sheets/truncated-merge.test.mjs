import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {build} from 'esbuild'
import JSZip from 'jszip'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {createWebAttachments} from '../../src/editors/web-attachments.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {restrictedOrigin} from '../helpers/restricted.mjs'

test('mixed spreadsheet attachments merge original data and survive save and reopen',{timeout:90000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-truncated-merge-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const manifest=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url)))
 const runtime=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:randomUUID(),DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256,DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs')},{enabled:true})
 t.after(()=>runtime.close())
 const base=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const sourceZip=await JSZip.loadAsync(base),marker='FINAL-ROW-40-COMPLETE-ORIGINAL-XLSX',values=Array.from({length:40},(_,i)=>`row-${i+1}:`+'x'.repeat(29900)+(i===39?marker:''))
 sourceZip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A40"/><sheetData>${values.map((value,i)=>`<row r="${i+1}"><c r="A${i+1}" t="inlineStr"><is><t>${value}</t></is></c></row>`).join('')}</sheetData></worksheet>`)
 const bytes=await sourceZip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
 assert.ok(bytes.length<50*1024*1024);assert.ok(values.join('').length>1_000_000)
 const f=await fileFixture(t,{...runtime}),initial=(await importFile(f,f.alice.token,base,'target.xlsx')).file
 const address=await f.app.listen({port:0,host:'127.0.0.1'})
 const fetchImpl=(path,init={})=>fetch(address+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token}})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey}),proof=csrf.sessionToken(f.alice.token)
 const parsed=[]
 const client=createWebAttachments(async(path,method,body)=>{
  const response=await fetchImpl(path,{method,headers:{'content-type':'application/octet-stream','x-csrf-token':proof},body})
  assert.equal(response.status,200,await response.clone().text());const result=await response.json();parsed.push(result);return result
 });t.after(()=>client.dispose())
 const original=new File([bytes],'large-source.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
 const path=client.getPathForFile(original),added=await client.addAttachmentPaths([path])
 assert.equal(added.rejected.length,0);assert.equal(added.accepted.length,1)
 assert.equal(parsed[0].ok,true);assert.equal(parsed[0].truncated,true);assert.equal(parsed[0].text.length,1_000_000);assert.equal(parsed[0].text.includes(marker),false)
 assert.equal(await client.getFileForPath(path),original)
 assert.equal(createHash('sha256').update(Buffer.from(await (await client.getFileForPath(path)).arrayBuffer())).digest('hex'),createHash('sha256').update(bytes).digest('hex'))
 const read=await client.readAttachment(path);assert.equal(read.ok,false);assert.equal(read.truncated,true)
 const macroBook=await JSZip.loadAsync(base)
 const types=await macroBook.file('[Content_Types].xml').async('string')
 macroBook.file('[Content_Types].xml',types.replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','application/vnd.ms-excel.sheet.macroEnabled.main+xml').replace('</Types>','<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'))
 const rels=await macroBook.file('xl/_rels/workbook.xml.rels').async('string')
 macroBook.file('xl/_rels/workbook.xml.rels',rels.replace('</Relationships>','<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>'))
 macroBook.file('xl/vbaProject.bin','VBA package marker')
 macroBook.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>XLSM marker</t></is></c><c r="B1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>')
 const extraSources=[
  [new File([await macroBook.generateAsync({type:'nodebuffer'})],'macro.xlsm'),['XLSM marker',3]],
  [new File(['id,value\r\ncsv-marker,"quoted, value"\r\n'],'tables.csv'),['csv-marker','quoted, value']],
  [new File(['id\tvalue\r\ntsv,a,b,c,d\tTSV marker\r\n'],'tables.TSV'),['tsv,a,b,c,d','TSV marker']],
  [new File([await readFile(new URL('../../../../apps/sheets/native/xlsx-engine/tests/fixtures/cell-styles.xls',import.meta.url))],'legacy.xls'),['Chair',6,200.5]],
 ]
 for(const [source] of extraSources){
  const sourcePath=client.getPathForFile(source),result=await client.addAttachmentPaths([sourcePath])
  assert.deepEqual(result.rejected,[])
  assert.equal(await client.getFileForPath(sourcePath),source)
  added.accepted.push(...result.accepted)
 }
 const mislabeled=client.getPathForFile(new File([base],'mislabeled.xls'))
 const rejected=await client.addAttachmentPaths([mislabeled])
 assert.equal(rejected.accepted.length,0)
 assert.match(rejected.rejected[0],/invalid or unsupported xls/i)
 assert.equal(await client.getFileForPath(mislabeled),null)
 const outfile=join(directory,'merge.mjs')
 await build({stdin:{contents:`export {createSheetsBridge} from './apps/web/src/editors/sheets-bridge.ts';export {createMergeSkill} from './apps/sheets/src/renderer/ai/merge-skill.ts';export {mergeAttachedWorkbooks} from './apps/sheets/src/renderer/merge-workbooks.ts';export {InsertSheetCommand} from '@univerjs/sheets'`,resolveDir:fileURLToPath(new URL('../../../../',import.meta.url)),loader:'ts'},loader:{'.md':'text','.ttf':'dataurl','.png':'dataurl','.css':'empty'},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge,createMergeSkill,mergeAttachedWorkbooks,InsertSheetCommand}=await import(pathToFileURL(outfile).href)
 const host=createSessionFileHost({fetchImpl});t.after(()=>host.dispose());await host.open(initial.fileId);await host.acquireLease(initial.fileId)
 const bridge=createSheetsBridge(host,initial.fileId,await host.getPreferences(),{fetchImpl,getAttachmentFile:client.getFileForPath});t.after(()=>bridge.dispose())
 const file=await bridge.api.selectWorkbook(),priorWindow=globalThis.window
 globalThis.window={desktopApi:bridge.api};t.after(()=>{globalThis.window=priorWindow})
 // Only the canvas is replaced: real merge reads and algorithms issue commands,
 // whose imported additions/cells feed the actual gateway planner and save.
 const additions=[],edits=[],sheets=file.sheets.map(sheet=>({getSheetName:()=>sheet.name})),commands=[]
 const commandService={async executeCommand(id,input){
  commands.push(id)
  if(id===InsertSheetCommand.id){additions.push(input.sheet);sheets.push({getSheetName:()=>input.sheet.name});return true}
  if(id==='sheet.command.set-range-values'){for(const [row,columns] of Object.entries(input.value))for(const [column,cell] of Object.entries(columns))edits.push({sheetId:input.subUnitId,row:Number(row),column:Number(column),writeValue:true,value:cell.v});return true}
  return true
 }}
 const workbook={getId:()=>file.sessionId,getSheets:()=>sheets},deps={runtime:{univerAPI:{getActiveWorkbook:()=>workbook},univer:{__getInjector:()=>({get:()=>commandService})}},lazyWorkbookRef:{current:null},setMessage(){}}
 const emptyPath=client.getPathForFile(new File(['\r\n'],'empty.csv'))
 assert.equal((await client.addAttachmentPaths([emptyPath])).accepted.length,1)
 await assert.rejects(()=>mergeAttachedWorkbooks(deps,[path,emptyPath]))
 assert.deepEqual(commands,[])
 const skill=createMergeSkill({supportedMergeExtensions:()=>bridge.supportedMergeExtensions,getAttachments:()=>added.accepted,mergePaths:paths=>mergeAttachedWorkbooks(deps,paths)})
 const execution=await skill.executeTool({id:'merge',name:'merge_attached_workbooks',input:{}})
 assert.equal(execution.isError,undefined,execution.output);assert.equal(execution.mutated,true);assert.equal(additions.length,5);assert.ok(commands.includes(InsertSheetCommand.id))
 const xlsxEdits=edits.filter(edit=>edit.sheetId===additions[0].id)
 assert.equal(xlsxEdits.length,40);assert.equal(xlsxEdits.at(-1).value,values[39])
 const request={...sheetsSaveRequest(file.sheets[0].id,[]),sessionId:file.sessionId,edits,sheetOps:additions.map(sheet=>({kind:'add-sheet',sheetId:sheet.id,name:sheet.name})),sheetOrder:[...file.sheets.map(sheet=>sheet.id),...additions.map(sheet=>sheet.id)]}
 const saved=await bridge.api.saveWorkbookEdits(request)
 assert.notEqual(bridge.getReceipt().revision,initial.revision)
 const reopened=await bridge.api.selectWorkbook(),imported=reopened.sheets.find(sheet=>sheet.name===additions[0].name)
 assert.ok(imported);assert.equal(reopened.sheets.length,file.sheets.length+5)
 const last=await bridge.api.readWorkbookRange({sessionId:reopened.sessionId,sheetId:imported.id,range:{startRow:39,endRow:39,startColumn:0,endColumn:0}})
 assert.equal(last.cells[0].value,values[39]);assert.ok(last.cells[0].value.endsWith(marker));assert.equal(saved.file.sha256,reopened.sha256)
 for(const [index,[,expected]] of extraSources.entries()){
  const sheet=reopened.sheets.find(sheet=>sheet.name===additions[index+1].name)
  assert.ok(sheet)
  const row=index===0?0:index===3?2:1
  const result=await bridge.api.readWorkbookRange({sessionId:reopened.sessionId,sheetId:sheet.id,range:{startRow:row,endRow:row,startColumn:0,endColumn:expected.length-1}})
  assert.deepEqual(result.cells.map(cell=>cell.value),expected)
  assert.ok(result.cells.every(cell=>!cell.formula))
 }
 const savedZip=await JSZip.loadAsync((await f.files.download(f.alice.token,initial.fileId,bridge.getReceipt().revision)).bytes)
 assert.equal(savedZip.file('xl/vbaProject.bin'),null)
 assert.deepEqual((await f.files.download(f.alice.token,initial.fileId,initial.revision)).bytes,base)
 const unauthorized=await fetch(address+'/api/v1/ai/attachments/parse?name=large-source.xlsx',{method:'POST',headers:{'content-type':'application/octet-stream',origin:restrictedOrigin,'x-csrf-token':proof},body:bytes})
 assert.equal(unauthorized.status,401)
})
