import {randomUUID} from 'node:crypto'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
import {configuredSheetsRuntime} from '../../server/src/modules/sheets/runtime.ts'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {restrictedOrigin} from '../helpers/restricted.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
test('authenticated Sheets routes use real Rust and reject foreign owners and browser paths',async t=>{
 const native=createXlsxNativeWorker(await sandboxFixture('native'))
 const {planWorkbookSave,readWorkbookPackage}=await sheetsGateway(t)
 const f=await fileFixture(t,{sheetsNative:native,sheetsPlanner:planWorkbookSave,sheetsPackageReader:readWorkbookPackage})
 const file=await importFile(f,f.alice.token,await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)),'acceptance.xlsx')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers=(token=f.alice.token)=>({cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)})
 const url='/api/v1/files/'+file.file.fileId+'/sheets/'
 const payload={revision:file.file.revision}
 const opened=await f.app.inject({method:'POST',url:url+'inspect',headers:headers(),payload})
 assert.equal(opened.statusCode,200,opened.body)
 assert.equal(opened.headers['cache-control'],'private, no-store')
 assert.equal(opened.json().sheets[0].name,'Acceptance')
 assert.equal(Object.hasOwn(opened.json(),'sessionId'),false)
 assert.equal(Object.hasOwn(opened.json(),'path'),false)
 const range=await f.app.inject({method:'POST',url:url+'range',headers:headers(),payload:{...payload,sheetName:'Acceptance',range:{startRow:1,endRow:1,startColumn:0,endColumn:5}}})
 assert.equal(range.statusCode,200,range.body)
 assert.equal(range.json().cells.find(c=>c.column===0).value,12.5)
 for(const token of [f.bob.token,f.adminSigned.token])assert.equal((await f.app.inject({method:'POST',url:url+'inspect',headers:headers(token),payload})).statusCode,404)
 assert.equal((await f.app.inject({method:'POST',url:url+'inspect',headers:headers(),payload:{...payload,path:'/etc/passwd'}})).statusCode,400)
 const computed=await f.app.inject({method:'POST',url:url+'recalculate',headers:headers(),payload:{...payload,edits:[],reads:[{sheetName:'Acceptance',range:{startRow:1,endRow:1,startColumn:1,endColumn:1}}]}})
 assert.equal(computed.statusCode,200,computed.body);assert.equal(computed.json().cells[0].number,25)
 const formulas=await f.app.inject({method:'POST',url:url+'sheet',headers:headers(),payload:{...payload,sheetName:'Acceptance',kind:'formulas'}})
 assert.equal(formulas.statusCode,200,formulas.body)
 assert.equal(formulas.json().cells.find(cell=>cell.row===1&&cell.column===1).formula,'=A2*2')
 const extras=await f.app.inject({method:'POST',url:url+'package',headers:headers(),payload})
 assert.equal(extras.statusCode,200,extras.body)
 assert.equal(extras.json().redactions.status,'absent')
 const editorId=randomUUID(),leases=createLeaseService({transactions:f.transactions})
 const lease=await leases.acquireLease(f.alice.token,file.file.fileId,{editorId})
 const draft=await f.app.inject({method:'POST',url:url+'uploads',headers:headers(),payload:{baseRevision:file.file.revision,leaseEpoch:lease.leaseEpoch,editorId,request:sheetsSaveRequest(opened.json().sheets[0].id,[{row:1,column:0,writeValue:true,value:25}])}})
 assert.equal(draft.statusCode,200,draft.body)
 assert.match(draft.json().sha256,/^[a-f0-9]{64}$/)
 assert.equal(draft.json().baseRevision,file.file.revision)
 assert.equal((await f.files.openFile(f.alice.token,file.file.fileId)).file.revision,file.file.revision)
 const missingCsrf=headers();delete missingCsrf['x-csrf-token']
 assert.equal((await f.app.inject({method:'POST',url:url+'inspect',headers:missingCsrf,payload})).statusCode,403)
 assert.equal((await f.app.inject({method:'POST',url:url+'inspect',headers:{...headers(),origin:'https://foreign.example'},payload})).statusCode,403)
})

test('CSV save route stages binary bytes with the authenticated revision and lease',async t=>{
 const f=await fileFixture(t,{sheetsNative:{savePlan:async()=>assert.fail('unexpected XLSX writer')},sheetsPlanner:async()=>assert.fail('unexpected XLSX planner')})
 const token=f.alice.token,original=Buffer.from('Item,Code\r\nA,007\r\n')
 const {file}=await importFile(f,token,original,'ledger.csv')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers={cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token),'content-type':'application/octet-stream'}
 const editorId=randomUUID(),leases=createLeaseService({transactions:f.transactions})
 const {leaseEpoch}=await leases.acquireLease(token,file.fileId,{editorId})
 const query=new URLSearchParams({baseRevision:file.revision,editorId,leaseEpoch:String(leaseEpoch)})
 const url='/api/v1/files/'+file.fileId+'/sheets/csv-uploads?'+query
 const payload=Buffer.from('\ufeffItem,Code\r\nB,007\r\n')
 const missingCsrf={...headers};delete missingCsrf['x-csrf-token']
 assert.equal((await f.app.inject({method:'POST',url,headers:missingCsrf,payload})).statusCode,403)
 const response=await f.app.inject({method:'POST',url,headers,payload})
 assert.equal(response.statusCode,200,response.body)
 assert.equal(response.json().size,payload.length)
 assert.equal(response.json().baseRevision,file.revision)
 assert.deepEqual(response.json().touchedEntries,[])
 assert.deepEqual((await f.files.openFile(token,file.fileId)).file,file)
})

test('Sheets reads a stored CSV as cells without replacing the source revision',async t=>{
 const f=await fileFixture(t,{buildApp:false})
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-csv-runtime-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
 },{enabled:true})
 t.after(()=>runtime.close())
 const {buildLocalApp}=await import('../../server/src/app.ts')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
  origin:restrictedOrigin,csrfKey:f.csrfKey,objectStore:f.objects,...runtime,
 })
 t.after(()=>app.close())
 const token=f.alice.token,bytes=Buffer.from('sep=;\r\nName;Code\r\nAlpha;007\r\n=1+2;42\r\n')
 const {file}=await importFile(f,token,bytes,'Ledger.csv')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const request=(path,payload,credential=token)=>app.inject({method:'POST',url:'/api/v1/files/'+file.fileId+'/sheets/'+path,
  headers:{cookie:'__Host-dyoffice-session='+credential,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(credential)},
  payload:{revision:file.revision,...payload},
 })
 const opened=await request('inspect',{})
 assert.equal(opened.statusCode,200,opened.body)
 assert.deepEqual(opened.json().sheets.map(sheet=>sheet.name),['Sheet1'])
 const query={sheetName:'Sheet1',range:{startRow:1,endRow:2,startColumn:0,endColumn:1}}
 const range=await request('range',query)
 assert.equal(range.statusCode,200,range.body)
 assert.deepEqual(range.json().cells.map(cell=>cell.value),['Alpha','007','=1+2',42])
 assert.equal(range.json().cells[2].formula,undefined)
 assert.equal((await request('range',query,f.bob.token)).statusCode,404)
 assert.deepEqual(await f.files.readFile(token,file.fileId,file.revision),bytes)
})

test('normal Sheets revision saves preserve the workbook type and opaque VBA project',async t=>{
 const {macroWorkbook,vbaFixture}=await import('../helpers/xlsm.mjs')
 const JSZip=(await import('jszip')).default
 const f=await fileFixture(t,{buildApp:false})
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-xlsm-runtime-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 await buildSheetsGateway(join(directory,'gateway.mjs'))
 const runtime=await configuredSheetsRuntime({DYOFFICE_AUTH_MODE:'local',DYOFFICE_SANDBOX_MODE:'subprocess',DYOFFICE_DEPLOYMENT_ID:f.deploymentId,
  DYOFFICE_XLSX_NODE_ENGINE:join(directory,'xlsx-node-engine.mjs'),DYOFFICE_XLSX_GATEWAY_RUNNER:join(directory,'gateway-process.mjs'),
 },{enabled:true})
 t.after(()=>runtime.close())
 const {buildLocalApp}=await import('../../server/src/app.ts')
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
  origin:restrictedOrigin,csrfKey:f.csrfKey,objectStore:f.objects,...runtime,
 })
 t.after(()=>app.close())
 const token=f.alice.token
 const original=await macroWorkbook(await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url)))
 const {file}=await importFile(f,token,original,'Ledger.XLSM')
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 const headers={cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)}
 const post=(path,payload)=>app.inject({method:'POST',url:'/api/v1/files/'+file.fileId+path,headers,payload})
 const editorId=randomUUID()
 const lease=await post('/lease',{editorId})
 assert.equal(lease.statusCode,200,lease.body)
 const {leaseEpoch}=lease.json()
 const opened=await post('/sheets/inspect',{revision:file.revision})
 assert.equal(opened.statusCode,200,opened.body)
 const sheet=opened.json().sheets[0]
 const draft=await post('/sheets/uploads',{baseRevision:file.revision,leaseEpoch,editorId,
  request:sheetsSaveRequest(sheet.id,[{row:1,column:0,writeValue:true,value:58}]),
 })
 assert.equal(draft.statusCode,200,draft.body)
 const result=await post('/commits',{fileId:file.fileId,baseRevision:file.revision,leaseEpoch,uploadId:draft.json().uploadId,idempotencyKey:randomUUID()})
 assert.equal(result.statusCode,200,result.body)
 const saved=await f.files.openFile(token,file.fileId)
 assert.equal(saved.format,'xlsm')
 assert.equal(saved.name,'Ledger.XLSM')
 assert.deepEqual(await f.files.readFile(token,file.fileId,file.revision),original)
 const zip=await JSZip.loadAsync(await f.files.readFile(token,file.fileId,saved.file.revision))
 assert.deepEqual(await zip.file('xl/vbaProject.bin').async('nodebuffer'),vbaFixture)
 assert.match(await zip.file('[Content_Types].xml').async('string'),/sheet\.macroEnabled\.main\+xml/)
 assert.match(await zip.file('xl/_rels/workbook.xml.rels').async('string'),/Target="vbaProject.bin"/)
 assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'),/<c\b[^>]*r="A2"[^>]*>\s*<v>58<\/v>/)
})
