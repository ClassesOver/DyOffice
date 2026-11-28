import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import officeCrypto from 'officecrypto-tool'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {sandboxFixture} from '../helpers/native-sandbox.mjs'
import {sheetsSaveRequest} from '../helpers/sheets-request.mjs'
import {sheetsGateway} from '../helpers/sheets-gateway.mjs'
import {createXlsxNativeWorker} from '../../worker/src/native/xlsx.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createSheetsSaveService} from '../../server/src/modules/sheets/save.ts'
import {createSheetsService} from '../../server/src/modules/sheets/service.ts'
async function fixture(t){
 const f=await fileFixture(t),bytes=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const initial=(await importFile(f,f.alice.token,bytes,'acceptance.xlsx')).file
 const leases=createLeaseService({transactions:f.transactions})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 return {...f,bytes,initial,leases,revisions,input:{baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,editorId}}
}
test('protected XLSX saves require unlock and only publish password-protected revisions',async t=>{
 const f=await fileFixture(t,{buildApp:false}),token=f.alice.token,password='Protected workbook fixture'
 const plain=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const original=Buffer.from(officeCrypto.encrypt(plain,{password}))
 const staged=await f.files.stageUpload(token,{name:'locked.xlsx',size:original.length})
 await f.files.receiveUpload(token,staged.uploadId,original,{password})
 const {file}=await f.files.finishUpload(token,staged.uploadId),fileId=file.fileId
 const leases=createLeaseService({transactions:f.transactions,assertOfficeWritable:f.files.assertOfficeLeaseAllowed})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),{leaseEpoch}=await leases.acquireLease(token,fileId,{editorId})
 const native={
  async inspect(input){return (await JSZip.loadAsync(input)).file('xl/worksheets/sheet1.xml').async('string')},
  async readRange(){throw Error('unexpected range')},
  async savePlan(input){
   const zip=await JSZip.loadAsync(input),path='xl/worksheets/sheet1.xml'
   const xml=await zip.file(path).async('string')
   zip.file(path,xml.replace('<v>12.5</v>','<v>73</v>'))
   return {bytes:await zip.generateAsync({type:'nodebuffer'})}
  },
 }
 const sheets=createSheetsService({files:f.files,native}),service=createSheetsSaveService({
  files:f.files,leases,revisions,native,protectedWorkbooks:sheets,plan:async()=>assert.fail('unexpected planner'),
  planFromWorkbook:async input=>{assert.deepEqual(input,plain);return {replaced:new Map(),added:new Map(),addedBinary:new Map(),removedEntries:[]}},
 })
 const input={baseRevision:file.revision,leaseEpoch,editorId,request:{}}
 await assert.rejects(revisions.stageUpload(token,fileId,{baseRevision:file.revision,leaseEpoch,editorId,size:plain.length}),{statusCode:423})
 const blocked=await revisions.stageProtectedWorkbookUpload(token,fileId,{baseRevision:file.revision,leaseEpoch,editorId,size:plain.length})
 await assert.rejects(f.files.receiveUpload(token,blocked.uploadId,plain),{statusCode:423})
 await f.files.cancelUpload(token,blocked.uploadId)
 await assert.rejects(service.prepare(token,fileId,input),{statusCode:423})
 const {unlockId}=await sheets.unlockWorkbook(token,fileId,file.revision,password)
 await assert.rejects(service.prepare(token,fileId,{...input,unlockId:randomUUID()}),{statusCode:423})
 const draft=await service.prepare(token,fileId,{...input,unlockId})
 assert.equal((await f.files.openFile(token,fileId)).file.revision,file.revision)
 const commit={fileId,uploadId:draft.uploadId,baseRevision:file.revision,leaseEpoch,idempotencyKey:randomUUID()}
 const saved=await revisions.commitRevision(token,commit)
 assert.deepEqual(await revisions.commitRevision(token,commit),saved)
 assert.equal((await f.files.openFile(token,fileId)).workbookPasswordProtected,true)
 const stored=await f.files.readFile(token,fileId,saved.revision)
 assert.equal(stored.subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1')
 const decrypted=await officeCrypto.decrypt(stored,{password})
 const expected=await native.inspect(decrypted)
 assert.match(expected,/<v>73<\/v>/)
 await assert.rejects(sheets.inspect(token,fileId,saved.revision),{statusCode:423})
 assert.equal(await sheets.inspect(token,fileId,saved.revision,undefined,false,unlockId),expected)
 assert.deepEqual(await f.files.readFile(token,fileId,file.revision),original)
})
test('changing the XLSX password publishes an encrypted revision and advances only its unlock grant',async t=>{
 const f=await fileFixture(t,{buildApp:false}),token=f.alice.token,password='Original password',next='  新密码🔑 '
 const plain=await readFile(new URL('../fixtures/sheets/acceptance.xlsx',import.meta.url))
 const original=Buffer.from(officeCrypto.encrypt(plain,{password}))
 const staged=await f.files.stageUpload(token,{name:'locked.xlsx',size:original.length})
 await f.files.receiveUpload(token,staged.uploadId,original,{password})
 const {file}=await f.files.finishUpload(token,staged.uploadId),fileId=file.fileId
 const leases=createLeaseService({transactions:f.transactions,assertOfficeWritable:f.files.assertOfficeLeaseAllowed})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),{leaseEpoch}=await leases.acquireLease(token,fileId,{editorId})
 const native={inspect:async input=>Buffer.from(input),readRange:async()=>assert.fail('unexpected range'),savePlan:async()=>assert.fail('unexpected rewrite')}
 const sheets=createSheetsService({files:f.files,native}),service=createSheetsSaveService({files:f.files,leases,revisions,native,protectedWorkbooks:sheets,plan:async()=>assert.fail('unexpected planner')})
 const input={baseRevision:file.revision,leaseEpoch,editorId,newPassword:next}
 await assert.rejects(()=>service.preparePassword(token,fileId,{...input,unlockId:randomUUID()}),{statusCode:423})
 const {unlockId}=await sheets.unlockWorkbook(token,fileId,file.revision,password)
 const other=await sheets.unlockWorkbook(token,fileId,file.revision,password)
 await assert.rejects(()=>service.preparePassword(token,fileId,{...input,unlockId,newPassword:'x'.repeat(256)}),{statusCode:400})
 const draft=await service.preparePassword(token,fileId,{...input,unlockId})
 assert.equal((await f.files.openFile(token,fileId)).file.revision,file.revision)
 assert.deepEqual(await sheets.inspect(token,fileId,file.revision,undefined,false,unlockId),plain)
 const commit={fileId,uploadId:draft.uploadId,baseRevision:file.revision,leaseEpoch,idempotencyKey:randomUUID()}
 const changed=await revisions.commitRevision(token,commit)
 assert.deepEqual(await revisions.commitRevision(token,commit),changed)
 const current=await f.files.openFile(token,fileId)
 assert.equal(current.workbookPasswordProtected,true)
 assert.equal(current.file.revision,changed.revision)
 const encrypted=await f.files.readFile(token,fileId,changed.revision)
 assert.deepEqual(Buffer.from(await officeCrypto.decrypt(encrypted,{password:next})),plain)
 await assert.rejects(sheets.unlockWorkbook(token,fileId,changed.revision,password),{statusCode:422})
 await assert.rejects(sheets.inspect(token,fileId,changed.revision,undefined,false,other.unlockId),{statusCode:423})
 assert.deepEqual(await sheets.inspect(token,fileId,changed.revision,undefined,false,unlockId),plain)
 const subsequent=await sheets.openForProtectedSave(token,fileId,changed.revision,unlockId)
 assert.deepEqual(Buffer.from(await officeCrypto.decrypt((await subsequent.seal(plain)).bytes,{password:next})),plain)
 assert.deepEqual(await f.files.readFile(token,fileId,file.revision),original)
})
test('native edited output stages a T06 upload and commits exactly once without changing original bytes',async t=>{
 const f=await fixture(t),native=createXlsxNativeWorker(await sandboxFixture('native'))
 const {planWorkbookSave,planFromWorkbook}=await sheetsGateway(t)
 const service=createSheetsSaveService({files:f.files,leases:f.leases,revisions:f.revisions,native,plan:planWorkbookSave,planFromWorkbook})
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
for(const boundary of ['lease','head','revocation','tombstone'])test(`optimized save retains real ${boundary} fencing after planning`,async t=>{
 const f=await fixture(t),{planFromWorkbook}=await sheetsGateway(t)
 let entered,release,calls=0
 const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
 const native={async inspect(){assert.fail('optimized path must not inspect source')},async savePlan(){calls++;entered();await gate;return {bytes:f.bytes}}}
 const service=createSheetsSaveService({files:f.files,leases:f.leases,revisions:f.revisions,native,plan:async()=>assert.fail('no fallback'),planFromWorkbook})
 const input={...f.input,request:sheetsSaveRequest('sheet-1',[{row:1,column:0,writeValue:true,value:23}])}
 for(const token of [f.bob.token,f.adminSigned.token])await assert.rejects(()=>service.prepare(token,f.initial.fileId,input),{statusCode:404})
 assert.equal(calls,0)
 const pending=service.prepare(f.alice.token,f.initial.fileId,input).then(value=>({value}),error=>({error}))
 await started
 let expected=f.initial.revision
 try{
   if(boundary==='lease')await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch})
   if(boundary==='revocation')await f.sessions.revoke(f.alice.token,f.alice.sessionId)
   if(boundary==='tombstone')await f.files.trashFile(f.alice.token,f.initial.fileId)
   if(boundary==='head'){
     const upload=await f.revisions.stageUpload(f.alice.token,f.initial.fileId,{...f.input,size:f.bytes.length})
     await f.files.receiveUpload(f.alice.token,upload.uploadId,f.bytes)
     expected=(await f.revisions.commitRevision(f.alice.token,{fileId:f.initial.fileId,uploadId:upload.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()})).revision
   }
 }finally{release()}
 const result=await pending
 assert.equal(result.error?.statusCode,boundary==='revocation'?401:boundary==='tombstone'?404:409)
 const uploads=await f.ownerDb.transaction(async connection=>{
   await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
   return connection.query("SELECT count(*)::integer AS count FROM uploads WHERE file_id=$1 AND state IN ('staged','receiving','ready')",[f.initial.fileId])
 })
 assert.equal(uploads.rows[0].count,0)
 if(!['revocation','tombstone'].includes(boundary))assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,expected)
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
