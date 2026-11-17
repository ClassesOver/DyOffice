import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createJobWorkerStore} from '../../server/src/modules/jobs/worker-store.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createJobService} from '../../server/src/modules/jobs/service.ts'
import {createTestPdfCommandQueue} from '../../server/src/pdf/command-queue.ts'
import {createTestPdfClaimReader} from '../../server/src/pdf/command-claim.ts'
const command={version:1,action:'rotatePages',operations:[{page:1,degrees:90}]}
async function fixture(t){
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior})
 const f=await fileFixture(t,{buildApp:false,worker:true}),doc=await PDFDocument.create();doc.addPage([200,100]);const file=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'claim.pdf')).file
 for(const name of ['command-queue','command-claim'])await f.ownerPool.query(await readFile(new URL(`../../server/src/pdf/${name}.candidate.sql`,import.meta.url),'utf8'))
 await f.ownerPool.query(`GRANT SELECT,INSERT ON pdf_job_commands TO ${f.names.business}`)
 await f.ownerPool.query(`GRANT EXECUTE ON FUNCTION read_pdf_claim_command(uuid,uuid,bigint,text) TO ${f.names.worker}`)
 const queue=createTestPdfCommandQueue({transactions:f.transactions,unsafeTestOnly:true}),worker=createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId})
 const reader=createTestPdfClaimReader({pool:f.workerPool,deploymentId:f.deploymentId,unsafeTestOnly:true})
 const enqueue=()=>queue.enqueue(f.alice.token,{artifactId:file.revision,command},randomUUID())
 const cred=c=>({jobId:c.jobId,epoch:c.epoch,token:c.token})
 const mutate=async(sql,values=[])=>{const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await c.query(sql,values);await c.query('COMMIT')}finally{c.release()}}
 return {...f,file,queue,worker,reader,enqueue,cred,mutate}
}
test('real concurrent claim has one winner and restricted worker reads only bound command facts',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claims=await Promise.all([f.worker.claim(job.id),f.worker.claim(job.id)]),claim=claims.find(Boolean)
 assert.equal(claims.filter(Boolean).length,1)
 const out=await f.reader.read(f.cred(claim));assert.deepEqual(out.command,command)
 assert.equal(out.facts.jobId,job.id);assert.equal(out.facts.ownerId,f.alice.user.id);assert.equal(out.facts.baseRevision,f.file.revision)
 assert.equal(out.facts.inputSha256,f.file.sha256);assert.equal(out.facts.inputSize,f.file.size)
 assert.ok(out.remainingMs>0);assert.equal('leaseEpoch' in out.facts,false)
 const text=JSON.stringify(out);assert.equal(text.includes(claim.token),false);assert.equal(text.includes('objectKey'),false)
 for(const sql of ['SELECT * FROM pdf_job_commands','UPDATE pdf_job_commands SET command_digest=command_digest','SELECT * FROM native_jobs','SELECT lock_job_principal(NULL,NULL,NULL,NULL,false)'])await assert.rejects(f.workerPool.query(sql),e=>e.code==='42501')
 await assert.rejects(f.businessPool.query('SELECT read_pdf_claim_command($1,$2,$3,$4)',[f.deploymentId,job.id,claim.epoch,'a'.repeat(64)]),e=>e.code==='42501')
})
test('wrong claim identity and epoch never select another command; reclaims fence old reader',async t=>{
 const f=await fixture(t),job=await f.enqueue(),other=await f.enqueue(),claim=await f.worker.claim(job.id)
 for(const bad of [{...f.cred(claim),jobId:other.id},{...f.cred(claim),epoch:claim.epoch+1},{...f.cred(claim),token:randomBytes(32).toString('base64url')},{...f.cred(claim),ownerId:f.alice.user.id}])await assert.rejects(f.reader.read(bad),{code:'PDF_CLAIM_DENIED'})
 await f.mutate("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id])
 const next=await f.worker.claim(job.id);assert.ok(next);assert.ok(next.epoch>claim.epoch)
 await assert.rejects(f.reader.read(f.cred(claim)),{code:'PDF_CLAIM_DENIED'})
 assert.equal((await f.reader.read(f.cred(next))).facts.jobEpoch,next.epoch)
})
test('cancel revoked session and modified persisted command fail closed',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id)
 await createJobService({transactions:f.transactions}).cancelJob(f.alice.token,job.id)
 await assert.rejects(f.reader.read(f.cred(claim)),{code:'PDF_CLAIM_DENIED'})
 const second=await f.enqueue(),c2=await f.worker.claim(second.id)
 const changed=JSON.stringify({...command,operations:[{page:1,degrees:180}]})
 await f.mutate("UPDATE pdf_job_commands SET command_json=$2,command_digest=encode(sha256(convert_to($2,'UTF8')),'hex') WHERE job_id=$1",[second.id,changed])
 await assert.rejects(f.reader.read(f.cred(c2)),{code:'PDF_CLAIM_DENIED'})
 const third=await f.enqueue(),c3=await f.worker.claim(third.id);await f.sessions.logout(f.alice.token)
 await assert.rejects(f.reader.read(f.cred(c3)),{code:'PDF_CLAIM_DENIED'})
})
test('candidate definer and runtime permissions remain restricted and cannot pollute schema',async t=>{
 const f=await fixture(t)
 const row=(await f.ownerPool.query("SELECT p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='read_pdf_claim_command(uuid,uuid,bigint,text)'::regprocedure")).rows[0]
 assert.equal(row.prosecdef,true);assert.deepEqual(row.proconfig,['search_path=pg_catalog']);assert.equal(row.rolsuper,false);assert.equal(row.rolbypassrls,false)
 for(const pool of [f.workerPool,f.businessPool,f.authPool])await assert.rejects(pool.query('CREATE TABLE public.pdf_pollution_probe(id int)'),e=>e.code==='42501')
 await assert.rejects(f.authPool.query('SELECT read_pdf_claim_command(NULL,NULL,NULL,NULL)'),e=>e.code==='42501')
 await assert.rejects(f.workerPool.query('INSERT INTO pdf_job_commands DEFAULT VALUES'),e=>e.code==='42501')
 const publicAcl=(await f.ownerPool.query("SELECT EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='read_pdf_claim_command(uuid,uuid,bigint,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed")).rows[0]
 assert.equal(publicAcl.allowed,false)
})
for(const boundary of ['claim','session'])test(`${boundary} expiry while waiting for command lock is rejected by the final running check`,async t=>{
 const f=await fixture(t),job=await f.enqueue(),worker=createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId,leaseMs:boundary==='claim'?650:30000}),claim=await worker.claim(job.id)
 let expiresAt=Date.parse(claim.leaseUntil)
 if(boundary==='session'){await f.mutate("UPDATE sessions SET expires_at=clock_timestamp()+interval '650 milliseconds' WHERE id=$1",[f.alice.sessionId]);expiresAt=Date.now()+650}
 const blocker=await f.ownerPool.connect(),waiting=await f.workerPool.connect()
 try{
  await blocker.query('BEGIN');await blocker.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await blocker.query('SELECT * FROM pdf_job_commands WHERE job_id=$1 FOR UPDATE',[job.id])
  await waiting.query('BEGIN');await waiting.query("SET LOCAL lock_timeout='1s'");await waiting.query("SET LOCAL statement_timeout='2s'")
  const pending=assert.rejects(waiting.query('SELECT read_pdf_claim_command($1,$2,$3,$4)',[f.deploymentId,claim.jobId,claim.epoch,createHash('sha256').update(claim.token).digest('hex')]),e=>e.code==='28000')
  const deadline=Date.now()+800;let observed=false
  while(Date.now()<deadline){const result=await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'",[f.database,f.workerPool.options.application_name]);if(result.rowCount){observed=true;break}await new Promise(resolve=>setTimeout(resolve,5))}
  assert.equal(observed,true,'must observe reader waiting on command row')
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiresAt-Date.now()+40)))
  await blocker.query('COMMIT');await pending
 }finally{await blocker.query('ROLLBACK');blocker.release();await waiting.query('ROLLBACK');waiting.release()}
})
test('disabled account cannot retain earlier claim read authority',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id)
 await f.reader.read(f.cred(claim))
 await f.users.update(f.adminSigned.token,f.alice.user.id,{status:'disabled'})
 await assert.rejects(f.reader.read(f.cred(claim)),{code:'PDF_CLAIM_DENIED'})
})
test('source head advance after claim is rejected even if worker renewal succeeds',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id)
 await f.reader.read(f.cred(claim))
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),editorId=randomUUID()
 const lease=await leases.acquireLease(f.alice.token,f.file.fileId,{editorId}),bytes=await f.files.readFile(f.alice.token,f.file.fileId,f.file.revision)
 const upload=await revisions.stageUpload(f.alice.token,f.file.fileId,{size:bytes.length,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,editorId})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
 await revisions.commitRevision(f.alice.token,{fileId:f.file.fileId,uploadId:upload.uploadId,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.ok(await f.worker.renew(claim))
 await assert.rejects(f.reader.read(f.cred(claim)),{code:'PDF_CLAIM_DENIED'})
})
test('wrapper rejects malformed persisted operations even when privileged hashes are consistent',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),text=JSON.stringify({...command,operations:[{page:0,degrees:90}]})
 await f.mutate(`WITH changed AS (UPDATE pdf_job_commands SET command_json=$2,command_digest=encode(sha256(convert_to($2,'UTF8')),'hex') WHERE job_id=$1 RETURNING command_digest)
 UPDATE native_jobs SET request_hash=encode(sha256(convert_to('{"type":"pdf.rotate","artifactId":"'||artifact_id::text||'","commandDigest":"'||changed.command_digest||'"}','UTF8')),'hex') FROM changed WHERE id=$1`,[job.id,text])
 await assert.rejects(f.reader.read(f.cred(claim)),{code:'PDF_CLAIM_DENIED'})
})
test('reader gates are closed in production and cannot switch into production after construction',async t=>{
 const f=await fixture(t),prior=process.env.NODE_ENV
 process.env.NODE_ENV='production'
 try{assert.throws(()=>createTestPdfClaimReader({pool:f.workerPool,deploymentId:f.deploymentId,unsafeTestOnly:true}),{code:'PDF_CLAIM_DENIED'});await assert.rejects(f.reader.read({jobId:randomUUID(),epoch:1,token:'a'.repeat(43)}),{code:'PDF_CLAIM_DENIED'})}finally{process.env.NODE_ENV=prior}
})
