import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createJobWorkerStore} from '../../server/src/modules/jobs/worker-store.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createTestPdfCommandQueue} from '../../server/src/pdf/command-queue.ts'
import {createTestPdfLeaseController} from '../../server/src/pdf/lease-controller.ts'
import {createTestNativeAuthorityVerifier} from '../../worker/src/sandbox/document-native-authority-pg.ts'
const command={version:1,action:'rotatePages',operations:[{page:1,degrees:90}]}
async function fixture(t,wrapObjects){
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior})
 const f=await fileFixture(t,{buildApp:false,worker:true,wrapObjects}),doc=await PDFDocument.create();doc.addPage([200,100]);const file=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'claim.pdf')).file
 for(const name of ['command-queue','command-claim'])await f.ownerPool.query(await readFile(new URL(`../../server/src/pdf/${name}.candidate.sql`,import.meta.url),'utf8'))
 await f.ownerPool.query(`GRANT SELECT,INSERT ON pdf_job_commands TO ${f.names.business}`)
 await f.ownerPool.query(`GRANT EXECUTE ON FUNCTION read_pdf_claim_command(uuid,uuid,bigint,text) TO ${f.names.worker}`)
 await f.ownerPool.query(await readFile(new URL('../../worker/src/sandbox/document-native-authority.candidate.sql',import.meta.url),'utf8'))
 await f.ownerPool.query(`GRANT EXECUTE ON FUNCTION document_native_authority(jsonb,text) TO ${f.names.worker}`)
 const queue=createTestPdfCommandQueue({transactions:f.transactions,unsafeTestOnly:true}),worker=createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId})
 const enqueue=()=>queue.enqueue(f.alice.token,{artifactId:file.revision,command},randomUUID())
 const cred=c=>({jobId:c.jobId,epoch:c.epoch,token:c.token})
 const mutate=async(sql,values=[])=>{const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await c.query(sql,values);await c.query('COMMIT')}finally{c.release()}}
 const leases=createLeaseService({transactions:f.transactions}),verify=createTestNativeAuthorityVerifier(f.workerPool,{schema:'public',unsafeTestOnly:true})
 const controller=(leaseTtlMs=45000)=>createTestPdfLeaseController({transactions:f.transactions,workerPool:f.workerPool,deploymentId:f.deploymentId,schema:'public',leaseTtlMs,unsafeTestOnly:true})
 return {...f,file,queue,worker,enqueue,cred,mutate,leases,verify,controller}
}

import * as preparation from '../../server/src/pdf/input-preparation.ts'

const build=(f,objects=f.objects)=>preparation.createTestPdfInputPreparation({transactions:f.transactions,workerPool:f.workerPool,objects,deploymentId:f.deploymentId,schema:'public',unsafeTestOnly:true})
const counts=f=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT count(*) FROM uploads)::int uploads,(SELECT count(*) FROM file_revisions)::int revisions,(SELECT count(*) FROM revision_commits)::int commits')).rows[0])
async function commitCurrent(f){
 const old=await f.leases.getLease(f.alice.token,f.file.fileId),editorId=randomUUID()
 const lease=old.active?await f.leases.takeoverLease(f.alice.token,f.file.fileId,{editorId,expectedEpoch:old.leaseEpoch}):await f.leases.acquireLease(f.alice.token,f.file.fileId,{editorId})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),bytes=await f.files.readFile(f.alice.token,f.file.fileId,f.file.revision)
 const upload=await revisions.stageUpload(f.alice.token,f.file.fileId,{size:bytes.length,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,editorId});await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
 await revisions.commitRevision(f.alice.token,{fileId:f.file.fileId,uploadId:upload.uploadId,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 await f.leases.releaseLease(f.alice.token,f.file.fileId,{editorId,leaseEpoch:lease.leaseEpoch})
 f.file.revision=(await f.files.openFile(f.alice.token,f.file.fileId)).file.revision
}
test('actual job-authorized PDF bytes are digest bound, privately copied and write no output',async t=>{
 const f=await fixture(t);await commitCurrent(f)
 const job=await f.enqueue(),claim=await f.worker.claim(job.id),before=await counts(f)
 assert.ok(before.uploads>0&&before.revisions>0&&before.commits>0)
 const snapshot=await build(f).prepare(f.cred(claim))
 assert.equal(snapshot.scope,'pdf-control-input-snapshot');assert.equal(snapshot.facts.jobId,job.id)
 const one=snapshot.copyBytes(),two=snapshot.copyBytes();assert.notEqual(one,two);assert.deepEqual(one,two)
 assert.equal(createHash('sha256').update(one).digest('hex'),snapshot.facts.inputSha256)
 one.fill(0);assert.deepEqual(snapshot.copyBytes(),two);assert.equal(JSON.stringify(snapshot).includes(claim.token),false)
 assert.deepEqual(await counts(f),before)
})
test('revoked job and pre-aborted input preparation perform no object reads',async t=>{
 let reads=0;const f=await fixture(t,store=>({...store,readVerified:async ref=>{reads++;return store.readVerified(ref)}})),job=await f.enqueue(),claim=await f.worker.claim(job.id),before=reads
 const ctl=new AbortController();ctl.abort()
 await assert.rejects(build(f).prepare(f.cred(claim),{signal:ctl.signal}),{code:'PDF_INPUT_ABORTED'})
 assert.equal(reads,before);await f.sessions.logout(f.alice.token)
 await assert.rejects(build(f).prepare(f.cred(claim)),{code:'PDF_INPUT_DENIED'});assert.equal(reads,before)
})
test('actual object I/O crossing claim expiry cannot yield a snapshot',async t=>{
 let slow=false,slowReads=0,enteredLive=false,expiredDuringRead=false
 const remaining=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>{
  const {rows}=await c.query('SELECT extract(epoch FROM (lease_until-clock_timestamp()))*1000 AS ms FROM native_jobs WHERE id=$1',[job.id])
  assert.equal(rows.length,1)
  return Number(rows[0].ms)
 })
 const f=await fixture(t,store=>({...store,readVerified:async ref=>{
  if(!slow)return store.readVerified(ref)
  // Start with the normal claim lifetime. Do not spend a 600ms deadline on
  // controller startup and then mistake pre-I/O denial for an I/O expiry test.
  enteredLive=await remaining()>0
  assert.equal(enteredLive,true,'the real object read must begin with a live claim')
  const bytes=await store.readVerified(ref);slowReads++
  // Let the actual database deadline pass while this verified read is pending.
  // Another transaction cannot shorten the locked job here without deadlocking.
  let ms=await remaining()
  while(ms>0){await new Promise(r=>setTimeout(r,Math.ceil(ms)+1));ms=await remaining()}
  expiredDuringRead=true
  return bytes
 }})),job=await f.enqueue(),claim=await f.worker.claim(job.id)
 slow=true
 await assert.rejects(build(f).prepare(f.cred(claim)),{code:'PDF_INPUT_DENIED'})
 assert.equal(enteredLive,true);assert.equal(expiredDuringRead,true)
 assert.equal(slowReads,1,'expiry must cross actual verified object I/O');assert.deepEqual(await counts(f),{uploads:1,revisions:1,commits:0})
})
test('object corruption, cancellation during I/O, and post-download revocation reject without output',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),before=await counts(f)
 const bad={...f.objects,readVerified:async ref=>{const bytes=await f.objects.readVerified(ref);bytes[0]^=1;return bytes}}
 await assert.rejects(build(f,bad).prepare(f.cred(claim)),{code:'PDF_INPUT_DENIED'})
 const ctl=new AbortController(),cancel={...f.objects,readVerified:async ref=>{const bytes=await f.objects.readVerified(ref);ctl.abort();return bytes}}
 await assert.rejects(build(f,cancel).prepare(f.cred(claim),{signal:ctl.signal}),{code:'PDF_INPUT_ABORTED'})
 assert.deepEqual(await counts(f),before)
 // Pause the real business transaction after download COMMIT, not inside its
 // locks: logout is a real separate transaction, never a fabricated principal.
 let transactions=0
 const tx=new Proxy(f.transactions,{get(target,key){const value=Reflect.get(target,key,target);if(key==='withPrincipalTransaction')return async(...args)=>{const result=await value.apply(target,args);transactions++;if(Buffer.isBuffer(result?.bytes))await f.sessions.logout(f.alice.token);return result};return typeof value==='function'?value.bind(target):value}})
 await assert.rejects(preparation.createTestPdfInputPreparation({transactions:tx,workerPool:f.workerPool,objects:f.objects,deploymentId:f.deploymentId,schema:'public',unsafeTestOnly:true}).prepare(f.cred(claim)),{code:'PDF_INPUT_DENIED'})
 assert.ok(transactions>0)
})

test('real T06 head change after download commit invalidates the snapshot',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),old=f.file.revision
 let changed=false
 const tx=new Proxy(f.transactions,{get(target,key){const value=Reflect.get(target,key,target);if(key==='withPrincipalTransaction')return async(...args)=>{const result=await value.apply(target,args);if(Buffer.isBuffer(result?.bytes)){await commitCurrent(f);changed=true}return result};return typeof value==='function'?value.bind(target):value}})
 await assert.rejects(preparation.createTestPdfInputPreparation({transactions:tx,workerPool:f.workerPool,objects:f.objects,deploymentId:f.deploymentId,schema:'public',unsafeTestOnly:true}).prepare(f.cred(claim)),{code:'PDF_INPUT_DENIED'})
 assert.equal(changed,true);assert.notEqual(f.file.revision,old);assert.deepEqual(await counts(f),{uploads:2,revisions:2,commits:1})
})
test('snapshot copy checks local cancellation and test gate without claiming fresh database authority',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),ctl=new AbortController(),raw=f.cred(claim)
 const pending=build(f).prepare(raw,{signal:ctl.signal});raw.jobId=randomUUID();raw.epoch++;raw.token='x'.repeat(43)
 const snapshot=await pending;assert.equal(snapshot.facts.jobId,job.id)
 ctl.abort();assert.throws(()=>snapshot.copyBytes(),{code:'PDF_INPUT_ABORTED'})
 const other=await build(f).prepare(f.cred(claim)),prior=process.env.NODE_ENV;process.env.NODE_ENV='production'
 try{assert.throws(()=>other.copyBytes(),{code:'PDF_INPUT_DENIED'});assert.throws(()=>build(f),{code:'PDF_INPUT_DENIED'})}finally{process.env.NODE_ENV=prior}
})
