import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {s3Fixture} from '../helpers/s3.mjs'
import {createJobService} from '../../server/src/modules/jobs/service.ts'
import {createJobWorkerStore} from '../../server/src/modules/jobs/worker-store.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createXlsxJobExecutor} from '../../worker/src/jobs/xlsx.ts'
import {MAX_OBJECT_BYTES} from '../../server/src/storage/object-store.ts'
import {blankXlsxBuffer} from '../../../../packages/xlsx-gateway/src/gateway/csv-import-xlsx.ts'
import {applyCellEditsToXlsx,assertOnlyTouchedEntriesChanged} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway.ts'
// Real gateway processing of a trusted generated fixture is injected ONLY in
// this test. It is not the Rust native adapter, sandbox, or production fallback.
async function setup(t){
 const s3=await s3Fixture(t), f=await fileFixture(t,{buildApp:false,worker:true,objectStore:s3.store})
 const original=await blankXlsxBuffer(), initial=(await importFile(f,f.alice.token,original,'job.xlsx')).file
 const jobs=createJobService({transactions:f.transactions,enabledTypes:['xlsx.roundtrip']}),store=createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId})
 const job=await jobs.enqueueJob(f.alice.token,'xlsx.roundtrip',{artifactId:initial.revision},randomUUID()),claim=await store.claim(job.id)
 assert.ok(claim)
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 return {...f,initial,jobs,store,job,claim,leases,revisions}
}
async function snapshot(f){return f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT current_revision FROM files WHERE id=$1) head,(SELECT count(*)::int FROM file_revisions WHERE file_id=$1) versions,(SELECT count(*)::int FROM revision_commits WHERE file_id=$1) receipts,(SELECT count(*)::int FROM revision_outbox WHERE file_id=$1) events',[f.initial.fileId])).rows[0])}
function harness(f,{mutation=false,receiptField,invalid,cancel=false}={}){
 let exported,snapshotBytes,staged=0,committed=0
 const native={async roundtrip(bytes){
  const result=await applyCellEditsToXlsx(Buffer.from(bytes),[]);assertOnlyTouchedEntriesChanged(result)
  await JSZip.loadAsync(result.buffer,{checkCRC32:true})
  exported=Buffer.from(result.buffer);snapshotBytes=Buffer.from(exported)
  if(cancel) await f.jobs.cancelJob(f.alice.token,f.job.id)
  return {bytes:invalid==='empty'?Buffer.alloc(0):invalid==='oversize'?Buffer.alloc(MAX_OBJECT_BYTES+1):exported,sheetCount:1}
 }}
 const revisions={...f.revisions,async stageUpload(...args){staged++;if(mutation)exported.fill(0);return f.revisions.stageUpload(...args)},async commitRevision(...args){committed++;return f.revisions.commitRevision(...args)}}
 const files={...f.files,async receiveUpload(...args){const r=await f.files.receiveUpload(...args);return receiptField?{...r,[receiptField]:receiptField==='size'?r.size+1:receiptField==='sha256'?'0'.repeat(64):randomUUID()}:r}}
 return {executor:createXlsxJobExecutor({store:f.store,files,leases:f.leases,revisions,native}),get bytes(){return snapshotBytes},get staged(){return staged},get committed(){return committed}}
}
test('actual XLSX gateway output traverses job authority, T06 and RustFS and atomically completes job',async t=>{
 const f=await setup(t),h=harness(f),before=await snapshot(f),saved=await h.executor.execute(f.claim)
 const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision)
 assert.deepEqual(bytes,h.bytes);assert.equal(saved.sha256,createHash('sha256').update(bytes).digest('hex'))
 const after=await snapshot(f);assert.equal(after.versions,before.versions+1);assert.equal(after.receipts,before.receipts+1);assert.equal(after.events,before.events+1)
 assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'succeeded');assert.equal(await f.store.claim(f.job.id),null)
 assert.equal((await f.leases.getLease(f.alice.token,f.initial.fileId)).active,false)
})
test('native-owned XLSX output mutation during stage cannot change saved snapshot',async t=>{
 const f=await setup(t),h=harness(f,{mutation:true}),saved=await h.executor.execute(f.claim)
 assert.deepEqual(await f.files.readFile(f.alice.token,saved.fileId,saved.revision),h.bytes)
})
for(const receiptField of ['uploadId','sha256','size'])test(`XLSX ${receiptField} receipt mismatch cannot commit or succeed job`,async t=>{
 const f=await setup(t),h=harness(f,{receiptField}),before=await snapshot(f)
 await assert.rejects(()=>h.executor.execute(f.claim),{code:'NATIVE_FAILED'})
 assert.equal(h.committed,0);assert.deepEqual(await snapshot(f),before)
 assert.notEqual((await f.jobs.getJob(f.alice.token,f.job.id)).state,'succeeded')
})
for(const invalid of ['empty','oversize'])test(`XLSX ${invalid} native result is rejected before stage`,async t=>{
 const f=await setup(t),h=harness(f,{invalid}),before=await snapshot(f)
 await assert.rejects(()=>h.executor.execute(f.claim),{code:invalid==='oversize'?'RESOURCE_LIMIT':'NATIVE_FAILED'})
 assert.equal(h.staged,0);assert.equal(h.committed,0);assert.deepEqual(await snapshot(f),before)
})
test('real cancellation during XLSX gateway work loses job authority before T06 writes',async t=>{
 const f=await setup(t),h=harness(f,{cancel:true}),before=await snapshot(f)
 await assert.rejects(()=>h.executor.execute(f.claim),{code:'AUTHORITY_LOST'})
 assert.equal(h.committed,0);assert.deepEqual(await snapshot(f),before);assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'cancelled')
})
