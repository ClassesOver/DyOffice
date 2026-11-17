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

async function setup(t,ttlMs=45_000){
  const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create();doc.addPage([200,100])
  const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'rotation.pdf')).file
  const leases=createLeaseService({transactions:f.transactions,ttlMs}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
  const input={token:f.alice.token,fileId:initial.fileId,baseRevision:initial.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),request:JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})}
  let rotations=0,uploads=0
  const job=createPdfRotationJob(),preparation=createPdfSavePreparation({files:f.files,leases,revisions:{...revisions,async stageUpload(...a){uploads++;return revisions.stageUpload(...a)}},processor:{async execute(...a){rotations++;return job.execute(...a)}}})
  return {...f,initial,input,revisions,leases,preparation,counts:()=>({rotations,uploads})}
}

async function expired(f){
 const deadline=Date.now()+10000
 while((await f.leases.getLease(f.alice.token,f.initial.fileId)).active){
  assert.ok(Date.now()<deadline,'lease must expire according to PostgreSQL time')
  await new Promise(resolve=>setTimeout(resolve,25))
 }
}
test('naturally expired lease fences prepared PDF commit and explicit retry without regenerate',async t=>{
 const f=await setup(t,5000),attempt=createPdfSaveAttempt({preparation:f.preparation,revisions:f.revisions},f.input)
 await attempt.prepare();await expired(f)
 for(let i=0;i<2;i++)await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'})
 assert.equal(attempt.status,'unknown');assert.deepEqual(f.counts(),{rotations:1,uploads:1})
 assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
 assert.equal((await f.revisions.listRevisions(f.alice.token,f.initial.fileId,{})).revisions.length,1)
 await assert.rejects(attempt.prepare(),{code:'PDF_SAVE_STATE'})
})
test('expired lease before preparation discloses no PDF bytes to processor and cannot stage',async t=>{
 const f=await setup(t,30);await expired(f)
 const attempt=createPdfSaveAttempt({preparation:f.preparation,revisions:f.revisions},f.input)
 await assert.rejects(attempt.prepare(),e=>e.statusCode===409)
 assert.deepEqual(f.counts(),{rotations:0,uploads:0});assert.equal(attempt.status,'failed')
 assert.equal((await f.files.openFile(f.alice.token,f.initial.fileId)).file.revision,f.initial.revision)
})
test('account disable fences prepared save and reenable never revives old-session retry',async t=>{
 const f=await setup(t),attempt=createPdfSaveAttempt({preparation:f.preparation,revisions:f.revisions},f.input)
 await attempt.prepare()
 await f.users.update(f.adminSigned.token,f.alice.user.id,{status:'disabled'})
 await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'})
 await f.users.update(f.adminSigned.token,f.alice.user.id,{status:'active'})
  await assert.rejects(f.sessions.authenticate(f.alice.token),e=>e.statusCode===401)
 await assert.rejects(attempt.commit(),{code:'PDF_COMMIT_UNKNOWN'})
 assert.equal(attempt.status,'unknown');assert.deepEqual(f.counts(),{rotations:1,uploads:1})
 const {password}=await import('../helpers/identity.mjs')
 const fresh=await f.sessions.login('alice',password)
 assert.equal((await f.files.openFile(fresh.token,f.initial.fileId)).file.revision,f.initial.revision)
 assert.equal((await f.revisions.listRevisions(fresh.token,f.initial.fileId,{})).revisions.length,1)
})
