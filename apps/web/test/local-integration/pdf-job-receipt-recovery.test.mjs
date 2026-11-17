import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {PDFDocument,degrees} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {createPrincipalTransactions} from '../../server/src/db/context.ts'
import {createJobWorkerStore} from '../../server/src/modules/jobs/worker-store.ts'
import {createJobService} from '../../server/src/modules/jobs/service.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createFileService} from '../../server/src/modules/files/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createTestPdfCommandQueue} from '../../server/src/pdf/command-queue.ts'
import {createPdfJobReceiptRecovery} from '../../server/src/pdf/job-receipt-recovery.ts'
async function fixture(t){
 const old=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old})
 const f=await fileFixture(t,{buildApp:false,worker:true}),doc=await PDFDocument.create();doc.addPage([200,100])
 const source=Buffer.from(await doc.save()),file=(await importFile(f,f.alice.token,source,'receipt.pdf')).file
 // Trusted test-owned construction, not execution of an untrusted input or grant.
 doc.getPage(0).setRotation(degrees(90));const output=Buffer.from(await doc.save())
 await f.ownerPool.query(await readFile(new URL('../../server/src/pdf/command-queue.candidate.sql',import.meta.url),'utf8'))
 await f.ownerPool.query(`GRANT SELECT,INSERT ON pdf_job_commands TO ${f.names.business}`)
 const queue=createTestPdfCommandQueue({transactions:f.transactions,unsafeTestOnly:true}),worker=createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId})
 const job=await queue.enqueue(f.alice.token,{artifactId:file.revision,command:{version:1,action:'rotatePages',operations:[{page:1,degrees:90}]}},randomUUID()),claim=await worker.claim(job.id)
 const auth={kind:'job',jobId:claim.jobId,epoch:claim.epoch,token:claim.token},leases=createLeaseService({transactions:f.transactions}),lease=await leases.acquireLease(auth,file.fileId,{editorId:job.id})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),upload=await revisions.stageUpload(auth,file.fileId,{size:output.length,baseRevision:file.revision,leaseEpoch:lease.leaseEpoch,editorId:job.id})
 await f.files.receiveUpload(auth,upload.uploadId,output)
 const input={fileId:file.fileId,uploadId:upload.uploadId,baseRevision:file.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:'job_'+job.id}
 const recovery=token=>createPdfJobReceiptRecovery({transactions:f.transactions,token:token??f.alice.token})
 const snapshot=token=>f.transactions.withPrincipalTransaction({kind:'session',token:token??f.alice.token},async c=>(await c.query("SELECT (SELECT count(*)::int FROM uploads) uploads,(SELECT count(*)::int FROM file_revisions) revisions,(SELECT count(*)::int FROM revision_commits) commits,(SELECT count(*)::int FROM revision_outbox) events,(SELECT current_revision FROM files WHERE id=$1) head,(SELECT state FROM native_jobs WHERE id=$2) state,(SELECT reserved_bytes::text FROM storage_accounts) reserved",[file.fileId,job.id])).rows[0])
 const mutate=async(sql,args=[])=>{const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await c.query(sql,args);await c.query('COMMIT')}finally{c.release()}}
 return {...f,file,source,output,job,claim,auth,lease,leases,revisions,input,recovery,snapshot,mutate}
}
function transactionProxy(f,query){
 const pool=new Proxy(f.businessPool,{get(target,key){if(key==='connect')return async()=>{const c=await target.connect();return new Proxy(c,{get(client,k){if(k==='query')return (...a)=>query(client,...a);const v=Reflect.get(client,k,client);return typeof v==='function'?v.bind(client):v}})};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v}})
 return createPrincipalTransactions({pool,deploymentId:f.deploymentId})
}
test('actual successful job commit with lost response is recovered by a fresh owner session without replay',async t=>{
 const f=await fixture(t);let lost=false
 const tx=transactionProxy(f,async(c,...a)=>{const result=await c.query(...a);if(a[0]==='COMMIT'){lost=true;throw Error('synthetic lost COMMIT response')}return result})
 await assert.rejects(createRevisionService({transactions:tx,objects:f.objects,files:f.files}).commitRevision(f.auth,f.input),/lost COMMIT/);assert.equal(lost,true)
 await f.sessions.logout(f.alice.token);const fresh=await f.sessions.login('alice',password),before=await f.snapshot(fresh.token)
 const result=await f.recovery(fresh.token).lookup(f.file.fileId,f.job.id)
 assert.equal(result.state,'committed');assert.equal(result.revision.revision,before.head);assert.equal(result.revision.fileId,f.file.fileId)
 for(const secret of [f.auth.token,f.input.idempotencyKey,f.input.uploadId])assert.equal(JSON.stringify(result).includes(secret),false)
 assert.deepEqual(await f.snapshot(fresh.token),before);assert.equal(before.commits,1);assert.equal(before.state,'succeeded')
 await assert.rejects(f.revisions.commitRevision(f.auth,f.input))
})
test('rollback before real COMMIT and not-yet-committed job remain unresolved with no writes',async t=>{
 const f=await fixture(t),before=await f.snapshot()
 assert.deepEqual(await f.recovery().lookup(f.file.fileId,f.job.id),{state:'unresolved'})
 const tx=transactionProxy(f,async(c,...a)=>{if(a[0]==='COMMIT')throw Error('synthetic before COMMIT');return c.query(...a)})
 await assert.rejects(createRevisionService({transactions:tx,objects:f.objects,files:f.files}).commitRevision(f.auth,f.input),/before COMMIT/)
 assert.deepEqual(await f.recovery().lookup(f.file.fileId,f.job.id),{state:'unresolved'});assert.deepEqual(await f.snapshot(),before)
 // Explicit test action, never performed by recovery itself.
 await f.revisions.commitRevision(f.auth,f.input);assert.equal((await f.recovery().lookup(f.file.fileId,f.job.id)).state,'committed')
})
test('current owner authorization precedes job lookup; cross-owner, admin and logged-out sessions fail',async t=>{
 const f=await fixture(t);await f.revisions.commitRevision(f.auth,f.input)
 for(const token of [f.bob.token,f.adminSigned.token])await assert.rejects(f.recovery(token).lookup(f.file.fileId,f.job.id))
 const other=(await importFile(f,f.alice.token,f.source,'other.pdf')).file
 assert.deepEqual(await f.recovery().lookup(other.fileId,f.job.id),{state:'unresolved'})
 assert.deepEqual(await f.recovery().lookup(f.file.fileId,randomUUID()),{state:'unresolved'})
 await f.sessions.logout(f.alice.token);await assert.rejects(f.recovery().lookup(f.file.fileId,f.job.id))
 assert.throws(()=>createPdfJobReceiptRecovery({transactions:f.transactions,token:f.auth}))
})
test('receipt requires complete persisted provenance and recomputed request hash',async t=>{
 const f=await fixture(t),saved=await f.revisions.commitRevision(f.auth,f.input)
 const rows=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT request_hash FROM revision_commits WHERE job_id=$1',[f.job.id])).rows)
 const mutations=[
  ['UPDATE revision_commits SET request_hash=$2 WHERE job_id=$1',[f.job.id,'a'.repeat(64)],'UPDATE revision_commits SET request_hash=$2 WHERE job_id=$1',[f.job.id,rows[0].request_hash]],
  ['UPDATE revision_commits SET job_epoch=job_epoch+1 WHERE job_id=$1',[f.job.id],'UPDATE revision_commits SET job_epoch=job_epoch-1 WHERE job_id=$1',[f.job.id]],
  ['UPDATE uploads SET editor_id=$2 WHERE id=$1',[f.input.uploadId,randomUUID()],'UPDATE uploads SET editor_id=$2 WHERE id=$1',[f.input.uploadId,f.job.id]],
  ['UPDATE uploads SET auth_version=auth_version+1 WHERE id=$1',[f.input.uploadId],'UPDATE uploads SET auth_version=auth_version-1 WHERE id=$1',[f.input.uploadId]],
  ['UPDATE file_revisions SET sha256=$2 WHERE id=$1',[saved.revision,'b'.repeat(64)],'UPDATE file_revisions SET sha256=$2 WHERE id=$1',[saved.revision,saved.sha256]],
  ['UPDATE native_jobs SET result_revision=$2 WHERE id=$1',[f.job.id,f.file.revision],'UPDATE native_jobs SET result_revision=$2 WHERE id=$1',[f.job.id,saved.revision]],
 ]
 for(const [change,args,restore,restoreArgs]of mutations){await f.mutate(change,args);const before=await f.snapshot();assert.deepEqual(await f.recovery().lookup(f.file.fileId,f.job.id),{state:'unresolved'});assert.deepEqual(await f.snapshot(),before);await f.mutate(restore,restoreArgs);assert.equal((await f.recovery().lookup(f.file.fileId,f.job.id)).state,'committed')}
 await f.mutate('DELETE FROM revision_commits WHERE job_id=$1',[f.job.id]);assert.deepEqual(await f.recovery().lookup(f.file.fileId,f.job.id),{state:'unresolved'})
})
test('historical job receipt survives later save, live reclaim is refused, and trash is denied',async t=>{
 const f=await fixture(t),saved=await f.revisions.commitRevision(f.auth,f.input),editorId=randomUUID(),lease=await f.leases.acquireLease(f.alice.token,f.file.fileId,{editorId})
 const upload=await f.revisions.stageUpload(f.alice.token,f.file.fileId,{size:f.source.length,baseRevision:saved.revision,leaseEpoch:lease.leaseEpoch,editorId});await f.files.receiveUpload(f.alice.token,upload.uploadId,f.source)
 const later=await f.revisions.commitRevision(f.alice.token,{fileId:f.file.fileId,uploadId:upload.uploadId,baseRevision:saved.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.notEqual(later.revision,saved.revision);assert.equal((await f.recovery().lookup(f.file.fileId,f.job.id)).revision.revision,saved.revision)
 await assert.rejects(f.mutate('UPDATE file_revisions SET reclaimed_at=clock_timestamp() WHERE id=$1',[saved.revision]),{code:'23514'});assert.equal((await f.recovery().lookup(f.file.fileId,f.job.id)).state,'committed')
 await f.files.trashFile(f.alice.token,f.file.fileId);await assert.rejects(f.recovery().lookup(f.file.fileId,f.job.id))
})
test('cancelled job is unresolved rather than a claimed commit failure or replay instruction',async t=>{
 const f=await fixture(t);await createJobService({transactions:f.transactions}).cancelJob(f.alice.token,f.job.id)
 const before=await f.snapshot();assert.deepEqual(await f.recovery().lookup(f.file.fileId,f.job.id),{state:'unresolved'});assert.deepEqual(await f.snapshot(),before)
})
async function waitBusinessLock(f){const deadline=Date.now()+2500;while(Date.now()<deadline){if((await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'",[f.database,f.businessPool.options.application_name])).rowCount)return;await new Promise(r=>setTimeout(r,5))}assert.fail('expected actual business row lock wait')}
function barrier(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('lookup and actual job commit serialize in both orders without file-to-job lock inversion',async t=>{
 for(const first of ['lookup','commit']){
  const f=await fixture(t),held=barrier(),release=barrier();let paused=false
  const tx=transactionProxy(f,async(c,...a)=>{
   const shouldPause=!paused&&(first==='lookup'?typeof a[0]==='string'&&a[0].includes('FROM files f JOIN file_revisions')&&a[0].includes('FOR SHARE OF f'):a[0]==='COMMIT')
   if(first==='commit'&&shouldPause){paused=true;held.resolve();await release.promise}
   const result=await c.query(...a)
   if(first==='lookup'&&shouldPause){paused=true;held.resolve();await release.promise}
   return result
  })
  let lookup,commit
  try{
   if(first==='lookup'){lookup=createPdfJobReceiptRecovery({transactions:tx,token:f.alice.token}).lookup(f.file.fileId,f.job.id);await held.promise;commit=f.revisions.commitRevision(f.auth,f.input)}
   else{commit=createRevisionService({transactions:tx,objects:f.objects,files:f.files}).commitRevision(f.auth,f.input);await held.promise;lookup=f.recovery().lookup(f.file.fileId,f.job.id)}
   await waitBusinessLock(f);release.resolve()
   const [result,saved]=await Promise.all([lookup,commit]);assert.equal(result.state,first==='lookup'?'unresolved':'committed')
   assert.equal((await f.recovery().lookup(f.file.fileId,f.job.id)).revision.revision,saved.revision)
  }finally{release.resolve();await Promise.allSettled([lookup,commit].filter(Boolean))}
 }
})
test('current session expiry while file lock waits prevents receipt return after final auth recheck',async t=>{
 const f=await fixture(t);await f.revisions.commitRevision(f.auth,f.input)
 await f.mutate("UPDATE sessions SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",[f.alice.sessionId])
 const blocker=await f.ownerPool.connect()
 try{
  await blocker.query('BEGIN');await blocker.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await blocker.query('SELECT id FROM files WHERE id=$1 FOR UPDATE',[f.file.fileId])
  const pending=assert.rejects(f.recovery().lookup(f.file.fileId,f.job.id),{statusCode:401})
  await waitBusinessLock(f)
  while(!(await blocker.query('SELECT expires_at<=clock_timestamp() expired FROM sessions WHERE id=$1',[f.alice.sessionId])).rows[0].expired)await new Promise(r=>setTimeout(r,10))
  await blocker.query('COMMIT');await pending
 }finally{await blocker.query('ROLLBACK');blocker.release()}
 const fresh=await f.sessions.login('alice',password);assert.equal((await f.recovery(fresh.token).lookup(f.file.fileId,f.job.id)).state,'committed')
})
test('a real trash committed while lookup waits on the file prevents receipt disclosure',async t=>{
 const f=await fixture(t);await f.revisions.commitRevision(f.auth,f.input)
 const held=barrier(),release=barrier();let paused=false
 const tx=transactionProxy(f,async(c,...a)=>{if(a[0]==='COMMIT'&&!paused){paused=true;held.resolve();await release.promise}return c.query(...a)})
 const files=createFileService({transactions:tx,objects:f.objects});let trash,lookup
 try{
  trash=files.trashFile(f.alice.token,f.file.fileId);await held.promise
  lookup=assert.rejects(f.recovery().lookup(f.file.fileId,f.job.id),{statusCode:404})
  await waitBusinessLock(f);release.resolve();await Promise.all([trash,lookup])
 }finally{release.resolve();await Promise.allSettled([trash,lookup].filter(Boolean))}
})
