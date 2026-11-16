import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfRotationJob} from '../../server/src/pdf/rotation-job.mjs'
import {createPdfSavePreparation} from '../../server/src/pdf/save-preparation.mjs'
import {createPdfSaveAttempt} from '../../server/src/pdf/save-attempt.mjs'

async function setup(t){
  const f=await fileFixture(t),doc=await PDFDocument.create();doc.addPage([200,100])
  const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'rotation.pdf')).file
  const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
  const input={token:f.alice.token,fileId:initial.fileId,baseRevision:initial.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),request:JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})}
  let rotations=0,uploads=0
  const job=createPdfRotationJob(),preparation=createPdfSavePreparation({files:f.files,leases,revisions:{...revisions,async stageUpload(...a){uploads++;return revisions.stageUpload(...a)}},processor:{async execute(...a){rotations++;return job.execute(...a)}}})
  return {...f,initial,input,revisions,leases,preparation,counts:()=>({rotations,uploads})}
}

test('committed-but-lost reply replays exact T06 receipt without another rotation/upload/revision',async t=>{
  const f=await setup(t);let lost=true,actual
  const attempt=createPdfSaveAttempt({preparation:f.preparation,revisions:{async commitRevision(...args){actual=await f.revisions.commitRevision(...args);if(lost){lost=false;throw Error('synthetic dropped response')}return actual}}},f.input)
  await attempt.prepare();await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'})
  assert.equal(attempt.status,'unknown')
  assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,actual.revision)
  assert.deepEqual(await attempt.commit(),actual)
  assert.deepEqual(f.counts(),{rotations:1,uploads:1})
  assert.equal((await f.revisions.listRevisions(f.alice.token,f.initial.fileId,{})).revisions.length,2)
  const bytes=await f.files.readFile(f.alice.token,actual.fileId,actual.revision)
  assert.equal((await PDFDocument.load(bytes)).getPage(0).getRotation().angle,90)
  await f.sessions.logout(f.alice.token)
  await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_RECHECK_FAILED'})
  assert.equal(attempt.status,'saved')
  assert.deepEqual(f.counts(),{rotations:1,uploads:1})
})

test('lease loss before dispatch leaves outcome unknown and never regenerates a draft on replay',async t=>{
  const f=await setup(t),attempt=createPdfSaveAttempt({preparation:f.preparation,revisions:f.revisions},f.input)
  await attempt.prepare()
  await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch})
  await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'})
  await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'})
  assert.equal(attempt.status,'unknown')
  assert.deepEqual(f.counts(),{rotations:1,uploads:1})
  assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
})
