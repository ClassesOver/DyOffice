import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfRotationJob} from '../../server/src/pdf/rotation-job.mjs'
import {createPdfSavePreparation} from '../../server/src/pdf/save-preparation.mjs'
const request=JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})
async function fixture(t){
  const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create();doc.addPage([200,100])
  const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'sample.pdf')).file
  const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
  const input={token:f.alice.token,fileId:initial.fileId,baseRevision:initial.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),request}
  const make=(processor=createPdfRotationJob())=>createPdfSavePreparation({files:f.files,leases,revisions,processor})
  return {...f,initial,leases,revisions,input,make}
}

test('real PostgreSQL preparation leaves head unchanged; explicit T06 commit saves rotated bytes and replay returns receipt',async t=>{
  const f=await fixture(t),prepared=await f.make().prepare(f.input)
  assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
  assert.equal(prepared.commitInput.baseRevision,f.initial.revision)
  const saved=await f.revisions.commitRevision(f.alice.token,prepared.commitInput)
  assert.equal(saved.sha256,prepared.sha256)
  assert.deepEqual(await f.revisions.commitRevision(f.alice.token,prepared.commitInput),saved)
  const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision)
  assert.equal((await PDFDocument.load(bytes)).getPage(0).getRotation().angle,90)
})

test('cross-user and stale lease reject before processor receives any bytes',async t=>{
  const f=await fixture(t);let calls=0
  const prep=f.make({execute(){calls++;throw Error('must not run')}})
  await assert.rejects(prep.prepare({...f.input,token:f.bob.token}),e=>e.statusCode===404)
  await assert.rejects(prep.prepare({...f.input,leaseEpoch:f.input.leaseEpoch+1}),e=>e.statusCode===409)
  assert.equal(calls,0)
})

test('lease takeover during native execution rejects stage and leaves original head',async t=>{
  const f=await fixture(t),job=createPdfRotationJob()
  const prep=f.make({async execute(...args){const out=await job.execute(...args);await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch});return out}})
  await assert.rejects(prep.prepare(f.input),e=>e.statusCode===409)
  assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
})

test('forged processor output digest cannot stage a save',async t=>{
  const f=await fixture(t),job=createPdfRotationJob()
  for(const altered of [{inputSha256:'0'.repeat(64)},{sha256:'0'.repeat(64)},{size:1}]) {
    await assert.rejects(f.make({async execute(...args){return {...await job.execute(...args),...altered}}}).prepare(f.input),{code:'PDF_OUTPUT_BINDING'})
  }
  assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
})

test('concurrent head advance rejects old source without creating a second revision',async t=>{
  const f=await fixture(t),job=createPdfRotationJob();let newer
  const prep=f.make({async execute(...args){
    const out=await job.execute(...args),other=await f.make().prepare({...f.input,idempotencyKey:randomUUID()})
    newer=await f.revisions.commitRevision(f.alice.token,other.commitInput)
    return out
  }})
  await assert.rejects(prep.prepare(f.input),e=>e.statusCode===409)
  assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,newer.revision)
  await assert.rejects(f.make().prepare(f.input),e=>e.statusCode===409)
})

test('abort after stage cancels draft and receive unknown-result cleanup never commits',async t=>{
  const f=await fixture(t),controller=new AbortController();let staged
  const base={files:f.files,leases:f.leases,revisions:f.revisions,processor:createPdfRotationJob()}
  const aborting=createPdfSavePreparation({...base,revisions:{...f.revisions,async stageUpload(...args){staged=await f.revisions.stageUpload(...args);controller.abort();return staged}}})
  await assert.rejects(aborting.prepare(f.input,{signal:controller.signal}),{code:'ABORTED'})
  await assert.rejects(f.files.receiveUpload(f.alice.token,staged.uploadId,Buffer.from('x')),e=>e.statusCode===409)
  const unknown=createPdfSavePreparation({...base,files:{...f.files,async receiveUpload(...args){await f.files.receiveUpload(...args);throw Object.assign(Error('lost response'),{code:'TEST_UNKNOWN'})}}})
  await assert.rejects(unknown.prepare(f.input),{code:'TEST_UNKNOWN'})
  assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes,0)
})

test('session revoked during processing cannot stage a write',async t=>{
  const f=await fixture(t),job=createPdfRotationJob()
  const prep=f.make({async execute(...args){const out=await job.execute(...args);await f.sessions.logout(f.alice.token);return out}})
  await assert.rejects(prep.prepare(f.input),e=>e.statusCode===401)
})
