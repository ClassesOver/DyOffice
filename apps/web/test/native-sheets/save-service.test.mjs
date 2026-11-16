import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createSheetsSaveService} from '../../server/src/modules/sheets/save.ts'
async function fixture(t){
 const f=await fileFixture(t),bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const initial=(await importFile(f,f.alice.token,bytes,'acceptance.xlsx')).file
 const leases=createLeaseService({transactions:f.transactions})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 return {...f,bytes,initial,leases,revisions,input:{baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,editorId}}
}
test('native edited output stages a T06 upload and commits exactly once without changing original bytes',async t=>{
 const f=await fixture(t),native=createXlsxNativeWorker(await sandboxFixture('native'))
 const {planWorkbookSave}=await sheetsGateway(t)
 const service=createSheetsSaveService({files:f.files,leases:f.leases,revisions:f.revisions,native,plan:planWorkbookSave})
 const metadata=await native.inspect(f.bytes)
 const request=sheetsSaveRequest(metadata.sheets[0].id,[{row:1,column:0,writeValue:true,value:21.25}])
 const draft=await service.prepare(f.alice.token,f.initial.fileId,{...f.input,request})
 assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
 const commit={fileId:f.initial.fileId,uploadId:draft.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()}
 const saved=await f.revisions.commitRevision(f.alice.token,commit)
 assert.equal(saved.sha256,draft.sha256);assert.equal(saved.size,draft.size)
 assert.deepEqual(await f.revisions.commitRevision(f.alice.token,commit),saved)
 assert.deepEqual(await f.files.readFile(f.alice.token,f.initial.fileId,f.initial.revision),f.bytes)
 const output=await f.files.readFile(f.alice.token,f.initial.fileId,saved.revision)
 const before=await JSZip.loadAsync(f.bytes),after=await JSZip.loadAsync(output)
 assert.match(await after.file('xl/worksheets/sheet1.xml').async('string'),/<v>21\.25<\/v>/)
 assert.deepEqual(await before.file('customXml/t09-preserve.xml').async('nodebuffer'),await after.file('customXml/t09-preserve.xml').async('nodebuffer'))
 await assert.rejects(()=>service.prepare(f.alice.token,f.initial.fileId,{...f.input,request}),{statusCode:409})
})
test('lease takeover while native save runs fences the output before staging',async t=>{
 const f=await fixture(t)
 let entered,release,calls=0
 const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
 const native={async inspect(){return {sheets:[{id:'1',name:'Acceptance'}]}},async savePlan(){calls++;entered();await gate;return {bytes:f.bytes}}}
 const service=createSheetsSaveService({files:f.files,leases:f.leases,revisions:f.revisions,native,plan:async()=>({})})
 const input={...f.input,request:sheetsSaveRequest('1',[{row:1,column:0,writeValue:true,value:23}])}
 await assert.rejects(()=>service.prepare(f.bob.token,f.initial.fileId,input))
 assert.equal(calls,0)
 const pending=service.prepare(f.alice.token,f.initial.fileId,input)
 await started
 await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch})
 release();await assert.rejects(pending,{statusCode:409})
 assert.equal((await f.files.usage(f.alice.token)).reservedBytes,0)
 assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
})
