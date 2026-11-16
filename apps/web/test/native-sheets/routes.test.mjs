import {randomUUID} from 'node:crypto'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
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
