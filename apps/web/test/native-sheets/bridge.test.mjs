import {test} from 'node:test'
import {createHash} from 'node:crypto'
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
import {createWebAttachments} from '../../src/editors/web-attachments.ts'
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
 assert.deepEqual(await bridge.api.listWorkbookTabs(),{tabs:[]},'linked ranges remain available without native tab routing')
 for(const method of ['readPivotDefinition','findWorkbookCells','updateWorkbookPassword','readExternalLinkUsage']){
  assert.equal(typeof bridge.api[method],'function',method)
  let operation
  assert.doesNotThrow(()=>{operation=bridge.api[method]({})},method)
  await assert.rejects(operation,error=>error.message.length>0&&!/is not a function/.test(error.message))
 }
})

test('browser printing keeps the selected workbook pages alive until the print dialog closes', async t => {
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-browser-print-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const outfile=join(dir,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge}=await import(pathToFileURL(outfile).href)
 const previous=globalThis.document
 const attributes=new Map()
 let removed=false, started
 const printing=new Promise(resolve=>{started=resolve})
 const printWindow=Object.assign(new EventTarget(),{
  document:{title:'',fonts:{ready:Promise.resolve()}},focus(){},
  print(){this.dispatchEvent(new Event('beforeprint'));started()},
 })
 const frame=Object.assign(new EventTarget(),{
  style:{},contentWindow:printWindow,
  setAttribute(name,value){attributes.set(name,value)},
  remove(){removed=true},
 })
 globalThis.document={
  createElement(tag){assert.equal(tag,'iframe');return frame},
  body:{append(child){assert.equal(child,frame);queueMicrotask(()=>child.dispatchEvent(new Event('load')))}},
 }
 t.after(()=>{globalThis.document=previous})
 const bridge=createSheetsBridge({},'unused',{language:'en',theme:'light'})
 t.after(()=>bridge.dispose())
 assert.equal(bridge.api.browserPrintDialog,true)
 assert.deepEqual(await bridge.api.listPrinters(),[])
 const output=bridge.api.printWorkbook({
  fileName:'Quarterly.pdf',html:'<!doctype html><html><body>Selected workbook page</body></html>',
  landscape:false,pageSize:'A4',margins:{top:0,bottom:0,left:0,right:0},scale:1,
 })
 await printing
 assert.equal(attributes.get('sandbox'),'allow-same-origin allow-modals')
 assert.match(frame.srcdoc,/Selected workbook page/)
 assert.equal(printWindow.document.title,'Quarterly')
 assert.equal(removed,false)
 printWindow.dispatchEvent(new Event('afterprint'))
 assert.deepEqual(await output,{ok:true})
 assert.equal(removed,true)
})

test('AI create_document delegates XLSX output to the authenticated shell creator', async t => {
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-create-xlsx-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const outfile=join(dir,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge}=await import(pathToFileURL(outfile).href)
 const previous=globalThis.window,received=[]
 globalThis.window={parent:{dyofficeCreateAiXlsx:async input=>received.push(input)}}
 t.after(()=>{globalThis.window=previous})
 const bridge=createSheetsBridge({},'unused',{language:'en',theme:'light'});t.after(()=>bridge.dispose())
 assert.deepEqual(bridge.supportedCreateDocumentTypes,['xlsx','csv'])
 const result=await bridge.api.createDocument({type:'xlsx',title:'Quarterly',sheetName:'Results',content:'Name,Value\nA,42'})
 assert.deepEqual(result,{ok:true})
 assert.deepEqual(received,[{title:'Quarterly',sheetName:'Results',content:'Name,Value\nA,42'}])
 const {runInNewContext}=await import('node:vm')
 globalThis.window.parent.dyofficeCreateAiXlsx=async()=>{throw runInNewContext('new Error("The workbook was created but could not be opened; check recent files before retrying.")')}
 assert.deepEqual(await bridge.api.createDocument({type:'xlsx',title:'Quarterly',content:'Name,Value\nA,42'}),{ok:false,error:'The workbook was created but could not be opened; check recent files before retrying.'})
 globalThis.window.parent=new Proxy({}, {get(){throw new DOMException('Blocked a frame','SecurityError')}})
 assert.deepEqual(bridge.supportedCreateDocumentTypes,['csv'])
})

test('AI XLSX create_document generates a real PDF before uploading it through the shell', async t => {
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-sheets-pdf-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const outfile=join(dir,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge}=await import(pathToFileURL(outfile).href)
 const {JSDOM}=await import('jsdom'),{PDFDocument}=await import('pdf-lib')
 const previous=globalThis.window,previousParser=globalThis.DOMParser,received=[]
 globalThis.window={parent:{dyofficeCreateAiDoc:async input=>received.push(input)}}
 globalThis.DOMParser=new JSDOM('').window.DOMParser
 t.after(()=>{globalThis.window=previous;if(previousParser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=previousParser})
 const font=await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url))
 const fetchImpl=async()=>new Response(font)
 const bridge=createSheetsBridge({},'unused',{language:'en',theme:'light'},{fetchImpl});t.after(()=>bridge.dispose())
 const result=await bridge.api.createDocument({type:'pdf',title:'季度报告',content:'<h1>经营结果</h1><p>收入增长 12%。</p>'})
 assert.deepEqual(result,{ok:true})
 assert.deepEqual(bridge.supportedCreateDocumentTypes,['csv','pdf'])
 assert.equal((await bridge.api.createDocument({type:'docx',title:'Unsupported report',content:'<p>Do not write</p>'})).ok,false)
 assert.equal(received.length,1)
 assert.equal(received[0].type,'pdf')
 assert.equal(received[0].file.type,'application/pdf')
 const bytes=new Uint8Array(await received[0].file.arrayBuffer()),pdf=await PDFDocument.load(bytes)
 assert.equal(pdf.getTitle(),'季度报告')
 assert.equal(pdf.getPageCount(),1)
})

for(const mode of ['attachment','manual']) test(`Web XLSX ${mode} merge sessions stream ranges through the authenticated bridge`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dyoffice-merge-bridge-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const outfile=join(dir,'bridge.mjs')
 await build({entryPoints:[fileURLToPath(new URL('../../src/editors/sheets-bridge.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const {createSheetsBridge}=await import(pathToFileURL(outfile).href)
 const bytes=Buffer.from('xlsx attachment'),sourceSession='d91a5506-41d7-4eb6-86e2-ec904707bc0e'
 const inspection={entryCount:1,sheets:[{id:'sheet-1',name:'Acceptance',rowCount:2,columnCount:6,columnWidths:[],defaultRowHeight:null,defaultColumnWidth:null,freeze:null,hidden:false,tabColor:null,showGridLines:true,tables:[],comments:[],pivotRanges:[]}],styles:[],dxfStyles:[],visuals:[],definedNames:[]}
 const rangeData={cells:[{row:1,column:0,value:12.5}],rows:[],merges:[],hyperlinks:[],conditionalRules:[],autoFilter:null,autoFilterColumns:[],dataValidations:[],sheetProtection:null,rowBreaks:[],colBreaks:[],pageSetup:null,protectedRanges:[],indexedThroughRow:1,indexingComplete:true}
 const calls=[],csrfToken='a'.repeat(43)
 const fetchImpl=async(path,init={})=>{
  calls.push({path,init})
  if(path==='/api/v1/auth/csrf')return new Response(JSON.stringify({csrfToken}),{headers:{'content-type':'application/json'}})
  if(path.includes('/merge-sources/open?'))return new Response(JSON.stringify({...inspection,sessionId:sourceSession,name:'source.xlsx',sha256:'a'.repeat(64),fileBytes:bytes.length,readOnly:true,needsSaveAs:false,automaticRecoveryDisabled:true}),{headers:{'content-type':'application/json'}})
  if(path.endsWith('/merge-sources/range')){
   const {range}=JSON.parse(init.body)
   if((range.endRow-range.startRow+1)*(range.endColumn-range.startColumn+1)>20_000)return new Response('{}',{status:500})
   const cells=[...rangeData.cells,{row:999,column:0,value:42}].filter(cell=>cell.row>=range.startRow&&cell.row<=range.endRow)
   const crossingMerge={startRow:768,endRow:769,startColumn:1,endColumn:1}
   const merges=range.startRow<=crossingMerge.endRow&&range.endRow>=crossingMerge.startRow?[crossingMerge]:[]
   return new Response(JSON.stringify({...rangeData,cells,merges}),{headers:{'content-type':'application/json'}})
  }
  if(path.endsWith('/merge-sources/close'))return new Response('{}',{headers:{'content-type':'application/json'}})
  throw new Error(`Unexpected request: ${path}`)
 }
 const host={getState:()=>({revision:{revision:'current-revision',sha256:'b'.repeat(64),size:1},name:'current.xlsx',lease:{}})}
 const file=new File([bytes],'source.xlsx')
 const attachments=createWebAttachments(async()=>({ok:true,kind:'text',text:'partial workbook text',truncated:true}))
 t.after(()=>attachments.dispose())
 const attachmentPath=attachments.getPathForFile(file)
 assert.equal((await attachments.addAttachmentPaths([attachmentPath])).accepted.length,1)
 const bridge=createSheetsBridge(host,'current-file',{language:'en',theme:'light'},{fetchImpl,getAttachmentFile:attachments.getFileForPath,pickMergeFiles:async()=>[file]})
 t.after(()=>bridge.dispose())
 const sources=mode==='manual'?await bridge.api.selectWorkbooksForMerge():await bridge.api.openWorkbooksForMerge([attachmentPath])
 assert.equal(sources.length,1);assert.equal(sources[0].name,'source.xlsx');assert.equal(sources[0].readOnly,true)
 const range=await bridge.api.readWorkbookRange({sessionId:sourceSession,sheetId:sources[0].sheets[0].id,range:{startRow:1,endRow:1,startColumn:0,endColumn:5}})
 assert.equal(range.cells.find(cell=>cell.column===0).value,12.5)
 const wideRange=await bridge.api.readWorkbookRange({sessionId:sourceSession,sheetId:sources[0].sheets[0].id,range:{startRow:0,endRow:999,startColumn:0,endColumn:25}})
 assert.deepEqual(wideRange.cells.map(cell=>cell.value),[12.5,42])
 assert.equal(wideRange.merges.length,1)
 await bridge.api.closeWorkbook(sourceSession)
 const uploads=calls.filter(call=>call.path.includes('/merge-sources/open?'))
 assert.equal(uploads.length,1)
 assert.equal(uploads[0].init.body,file)
 assert.deepEqual(Buffer.from(await uploads[0].init.body.arrayBuffer()),bytes)
 assert.equal(createHash('sha256').update(Buffer.from(await uploads[0].init.body.arrayBuffer())).digest('hex'),createHash('sha256').update(bytes).digest('hex'))
 assert.equal(uploads[0].init.credentials,'same-origin')
 assert.equal(uploads[0].init.headers['x-csrf-token'],csrfToken)
 assert.ok(calls.some(call=>call.path.endsWith('/merge-sources/range')))
 assert.ok(calls.some(call=>call.path.endsWith('/merge-sources/close')))
})
