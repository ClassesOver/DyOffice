import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {build} from 'esbuild'
import JSZip from 'jszip'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {restrictedOrigin} from '../helpers/restricted.mjs'

async function setup(t,nodeEngine=false){
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-pivot-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const gateway=await import(pathToFileURL(join(directory,'gateway.mjs')).href)
 const manifest=JSON.parse(await readFile(new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url)))
 const runtime=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:randomUUID(),...(nodeEngine?{DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs')}:{}),DYOFFICE_NATIVE_BINARY:manifest.nativeBinary,DYOFFICE_NATIVE_SHA256:manifest.nativeSha256,DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs')},{enabled:true})
 t.after(()=>runtime.close())
 const zip=await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G4"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>East</t></is></c><c r="B2"><v>100</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>West</t></is></c><c r="B3"><v>50</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>East</t></is></c><c r="B4"><v>50</v></c></row></sheetData></worksheet>`)
 const base=await zip.generateAsync({type:'nodebuffer'}),request=sheetsSaveRequest('sheet-1',[])
 request.pivotAdditions=[{sheetId:'sheet-1',sourceSheetId:'sheet-1',sourceArea:{startRow:0,startColumn:0,endRow:3,endColumn:1},location:{startRow:0,startColumn:5,endRow:3,endColumn:6},name:'Sales',fieldNames:['Region','Amount'],rowFieldIndices:[0],rowItems:['East','West'],values:[{fieldIndex:1,agg:'sum'}]}]
 const plan=await gateway.planFromWorkbook(base,request)
 const bytes=(await runtime.sheetsNative.savePlan(base,plan)).bytes
 const f=await fileFixture(t,{...runtime}),initial=(await importFile(f,f.alice.token,bytes,'pivot.xlsx')).file
 const address=await f.app.listen({port:0,host:'127.0.0.1'})
 const fetchImpl=(path,init={})=>fetch(address+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+f.alice.token}})
 const outfile=join(directory,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge}=await import(pathToFileURL(outfile).href)
 const host=createSessionFileHost({fetchImpl});t.after(()=>host.dispose())
 await host.open(initial.fileId);await host.acquireLease(initial.fileId)
 const bridge=createSheetsBridge(host,initial.fileId,await host.getPreferences(),{fetchImpl});t.after(()=>bridge.dispose())
 const file=await bridge.api.selectWorkbook(),pivot=file.sheets[0].pivotTables[0]
 assert.ok(pivot?.cachePath,'fixture must expose a real existing pivot')
 return {f,runtime,host,bridge,file,pivot,initial,directory}
}

for(const nodeEngine of [false,true]){
const backend=nodeEngine?'Node':'Rust'
test(backend+' authorized pivot definitions use the pinned workbook and reject foreign owners and arbitrary parts',{timeout:60000},async t=>{
 const {f,bridge,file,pivot,initial}=await setup(t,nodeEngine)
 const definition=await bridge.api.readPivotDefinition({sessionId:file.sessionId,path:pivot.path,cachePath:pivot.cachePath})
 assert.equal(definition.sourceSheet,'Acceptance');assert.equal(definition.sourceRef,'A1:B4')
 assert.deepEqual(definition.fields.map(field=>field.name),['Region','Amount'])
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const payload={revision:initial.revision,path:pivot.path,cachePath:pivot.cachePath},url=`/api/v1/files/${initial.fileId}/sheets/pivot-definition`
 const call=(token,body)=>f.app.inject({method:'POST',url,headers:{cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)},payload:body})
 for(const token of [f.bob.token,f.adminSigned.token])assert.equal((await call(token,payload)).statusCode,404)
 for(const path of ['/etc/passwd','xl/../workbook.xml','xl/styles.xml','xl/pivotTables/missing.xml'])assert.equal((await call(f.alice.token,{...payload,path})).statusCode,400)
 assert.equal((await call(f.alice.token,{...payload,cachePath:'xl/pivotCache/missing.xml'})).statusCode,400)
 await assert.rejects(()=>bridge.api.readPivotDefinition({sessionId:file.sessionId,path:'xl/styles.xml',cachePath:pivot.cachePath}))
})


test(backend+' refresh_pivot consumes the web definition and persists recomputed values through save and reopen',{timeout:60000},async t=>{
 const {bridge,file,pivot,directory,f,initial}=await setup(t,nodeEngine)
 const definition=await bridge.api.readPivotDefinition({sessionId:file.sessionId,path:pivot.path,cachePath:pivot.cachePath})
 const outfile=join(directory,'refresh.mjs')
 await build({stdin:{contents:`export {refreshPivotTables} from './apps/sheets/src/renderer/pivot-actions.ts';export {createEditJournal} from './apps/sheets/src/renderer/edit-journal.ts';export {executeWorkbookTool} from './apps/sheets/src/renderer/ai/tools.ts'`,resolveDir:fileURLToPath(new URL('../../../../',import.meta.url)),loader:'ts'},loader:{'.md':'text','.ttf':'dataurl','.png':'dataurl','.css':'empty'},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {refreshPivotTables,createEditJournal,executeWorkbookTool}=await import(pathToFileURL(outfile).href)
 const journal=createEditJournal(),written=[]
 // A small facade replaces the canvas only; the real pivot action, aggregate
 // engine, tool execution, HTTP bridge, planner and native archive save all run.
 const worksheet={getSheetName:()=>definition.sourceSheet,getRange(address){
  if(address===definition.sourceRef)return {getRawValues:()=>[['Region','Amount'],['East',200],['West',50],['East',50]],getNumberFormats:()=>[]}
  return {setValues(values){written.push({address,values})}}
 }}
 const workbook={getSheetBySheetId:()=>worksheet,getSheets:()=>[worksheet]}
 const state={file,formulaMode:true,flags:{preloadComplete:true},pivotDefinitions:new Map([[pivot.path,definition]]),editJournal:journal}
 const context={lazyWorkbookRef:{current:state},univerRef:{current:{univerAPI:{getActiveWorkbook:()=>workbook}}},setPendingEdits:()=>{}}
 const execution=await executeWorkbookTool({id:'refresh',name:'propose_operations',input:{summary:'Refresh Sales',operations:[{op:'refresh_pivot',sheetId:file.sheets[0].id}]}},{
  getActiveSheetInfo:()=>({sheets:file.sheets}),
  proposeOperations(operations){
   assert.deepEqual(operations,[{op:'refresh_pivot',sheetId:file.sheets[0].id}])
   assert.equal(refreshPivotTables(context,file.sheets[0].id),1)
   return {ok:true,plan:{cellChanges:[],formatChanges:[],sheetRenames:[],structuralChanges:[],warnings:[]}}
  },
 })
 assert.equal(execution.isError,undefined);assert.equal(execution.mutated,true)
 assert.equal(written[0].address,'G2:G4')
 assert.deepEqual(written[0].values.map(row=>row[0].v),[250,50,300])
 const edits=[{row:1,column:1,writeValue:true,value:200},...written[0].values.map((row,index)=>({row:index+1,column:6,writeValue:true,value:row[0].v}))]
 const request={...sheetsSaveRequest(file.sheets[0].id,edits),sessionId:file.sessionId,pivotCacheRefreshPaths:[...journal.pivotCacheRefresh]}
 assert.deepEqual(request.pivotCacheRefreshPaths,[pivot.cachePath])
 const saved=await bridge.api.saveWorkbookEdits(request)
 assert.notEqual(saved.file.sha256,file.sha256)
 const committed=await f.files.download(f.alice.token,initial.fileId,bridge.getReceipt().revision)
 const archive=await JSZip.loadAsync(committed.bytes)
 assert.match(await archive.file(pivot.cachePath).async('string'),/refreshOnLoad="1"/)
 const reloaded=await bridge.api.readPivotDefinition({sessionId:saved.file.sessionId,path:pivot.path,cachePath:pivot.cachePath})
 assert.equal(reloaded.sourceRef,'A1:B4')
 const result=await bridge.api.readWorkbookRange({sessionId:saved.file.sessionId,sheetId:file.sheets[0].id,range:{startRow:1,endRow:3,startColumn:6,endColumn:6}})
 assert.deepEqual(result.cells.map(cell=>cell.value),[250,50,300])
 // The old renderer session remains pinned to its authorized immutable bytes.
 const original=await bridge.api.readPivotDefinition({sessionId:file.sessionId,path:pivot.path,cachePath:pivot.cachePath})
 assert.equal(original.outputRef,'F1:G4')
})

}
