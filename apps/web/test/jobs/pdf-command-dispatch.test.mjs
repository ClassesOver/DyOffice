import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {execFile,fork} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createJobWorkerStore} from '../../server/src/modules/jobs/worker-store.ts'
import {createJobService} from '../../server/src/modules/jobs/service.ts'
import {createJobQueue,createJobDispatcher} from '../../server/src/outbox/dispatcher.ts'
import {createTestPdfCommandQueue} from '../../server/src/pdf/command-queue.ts'
import {createTestPdfClaimReader} from '../../server/src/pdf/command-claim.ts'
import {createTestPdfInputPreparation} from '../../server/src/pdf/input-preparation.ts'
import {createDocumentExecutionBoundary} from '../../worker/src/sandbox/document-execution-boundary.ts'
const command={version:1,action:'rotatePages',operations:[{page:1,degrees:90}]}
const cred=({jobId,epoch,token})=>({jobId,epoch,token})
function childEnvironment(payload){
 const env={NODE_ENV:'test',PDF_DISPATCH_FIXTURE:JSON.stringify(payload)}
 // Preserve only runtime/loader and locale settings, never parent test/service
 // credentials (in particular the disposable PostgreSQL administrator URL).
 for(const name of ['PATH','HOME','TMPDIR','TEMP','TMP','NODE_OPTIONS','LD_LIBRARY_PATH','LANG','LC_ALL','TZ'])if(process.env[name]!==undefined)env[name]=process.env[name]
 assert.equal('DYOFFICE_TEST_DATABASE_URL' in env,false)
 for(const secret of [process.env.DYOFFICE_TEST_DATABASE_URL])if(secret)assert.equal(Object.values(env).some(value=>value.includes(secret)),false)
 return env
}

async function fixture(t){
 const old=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old})
 const f=await fileFixture(t,{buildApp:false,worker:true}),pdf=await PDFDocument.create();pdf.addPage([200,100])
 const file=(await importFile(f,f.alice.token,Buffer.from(await pdf.save()),'dispatch.pdf')).file
 for(const name of ['command-queue','command-claim'])await f.ownerPool.query(await readFile(new URL(`../../server/src/pdf/${name}.candidate.sql`,import.meta.url),'utf8'))
 await f.ownerPool.query(`GRANT SELECT,INSERT ON pdf_job_commands TO ${f.names.business}`)
 await f.ownerPool.query(`GRANT EXECUTE ON FUNCTION read_pdf_claim_command(uuid,uuid,bigint,text) TO ${f.names.worker}`)
 await f.ownerPool.query(await readFile(new URL('../../worker/src/sandbox/document-native-authority.candidate.sql',import.meta.url),'utf8'))
 await f.ownerPool.query(`GRANT EXECUTE ON FUNCTION document_native_authority(jsonb,text) TO ${f.names.worker}`)
 const commands=createTestPdfCommandQueue({transactions:f.transactions,unsafeTestOnly:true})
 const worker=createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId})
 const jobs=createJobService({transactions:f.transactions})
 const reader=createTestPdfClaimReader({pool:f.workerPool,deploymentId:f.deploymentId,unsafeTestOnly:true})
 const input=createTestPdfInputPreparation({transactions:f.transactions,workerPool:f.workerPool,objects:f.objects,deploymentId:f.deploymentId,schema:'public',unsafeTestOnly:true})
 const url=process.env.DYOFFICE_TEST_REDIS_URL;assert.ok(url,'Dedicated disposable loopback Redis required');assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname))
 const queue=await createJobQueue({url,name:'dyoffice-test-'+randomUUID()})
 f.cleanup.unshift(async()=>{try{await queue.queue.obliterate({force:true})}finally{await queue.close()}})
 const dispatcher=createJobDispatcher({store:worker,queue})
 const job=await commands.enqueue(f.alice.token,{artifactId:file.revision,command},randomUUID())
 const due=()=>f.ownerPool.query("UPDATE job_outbox SET next_delivery_at=clock_timestamp()-interval '1 second',lease_until=CASE WHEN lease_hash IS NULL THEN NULL ELSE clock_timestamp()-interval '1 second' END WHERE job_id=$1",[job.id])
 return {...f,file,commands,worker,jobs,reader,input,queue,dispatcher,job,due}
}
async function waitFor(check){const until=Date.now()+10000;while(!await check()){assert.ok(Date.now()<until,'durable PDF queue did not reach expected state');await new Promise(r=>setTimeout(r,20))}}
async function consume(f,execute,count=1){
 const failures=[]
 const consumer=f.queue.consume(f.worker,execute)
 consumer.on('failed',(_job,error)=>failures.push(error))
 f.cleanup.unshift(()=>consumer.close(true));await consumer.waitUntilReady()
 await waitFor(async()=>await f.queue.queue.getCompletedCount()+await f.queue.queue.getFailedCount()>=count)
 await consumer.close();return failures
}
async function freshRead(f,claim){
 // A new Node process receives only the restricted worker connection and claim.
 // Its stdout is metadata only, never the credential or object-store key.
 const script=`import pg from 'pg';import {createTestPdfClaimReader} from './apps/web/server/src/pdf/command-claim.ts';if('DYOFFICE_TEST_DATABASE_URL' in process.env)throw Error('Owner URL must not reach reader');const x=JSON.parse(process.env.PDF_DISPATCH_FIXTURE);const pool=new pg.Pool({connectionString:x.url});try{const out=await createTestPdfClaimReader({pool,deploymentId:x.deploymentId,unsafeTestOnly:true}).read(x.claim);console.log(JSON.stringify({command:out.command,digest:out.digest,facts:out.facts}))}catch(e){console.log(JSON.stringify({error:e.code}))}finally{await pool.end()}`
 const {stdout}=await promisify(execFile)(process.execPath,['--experimental-transform-types','--input-type=module','-e',script],{cwd:new URL('../../../../',import.meta.url),timeout:10000,env:childEnvironment({url:f.urls.worker,deploymentId:f.deploymentId,claim:cred(claim)})})
 assert.equal(stdout.includes(claim.token),false);assert.equal(stdout.includes('objectKey'),false)
 return JSON.parse(stdout)
}
async function closedExecution(f,claim){
 const snapshot=await f.input.prepare(cred(claim));assert.deepEqual(snapshot.command,command)
 const before=await f.files.openFile(f.alice.token,f.file.fileId)
 // A control-plane observation is NOT an executable request. The actual
 // production boundary has no injectable backend and must refuse it.
 await assert.rejects(createDocumentExecutionBoundary().run(snapshot,snapshot.copyBytes()),{code:'DOCUMENT_BOUNDARY_UNAVAILABLE'})
 assert.equal((await f.files.openFile(f.alice.token,f.file.fileId)).file.revision,before.file.revision)
 assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'running')
 assert.equal(await f.worker.fail(claim,'NATIVE_FAILED',false),true)
 return snapshot
}

test('PDF lost dispatch acknowledgement duplicates opaque Redis hints, not command or execution; fresh process restores exact claim command',async t=>{
 const f=await fixture(t)
 const crashed=createJobDispatcher({store:f.worker,queue:{async enqueueHint(hint){await f.queue.enqueueHint(hint);throw Error('controlled ack loss')}}})
 await assert.rejects(crashed.runOnce(),/controlled ack loss/);await f.due();assert.equal(await f.dispatcher.runOnce(),true)
 const hints=await f.queue.queue.getJobs(['waiting']);assert.equal(hints.length,2)
 for(const hint of hints){assert.deepEqual(Object.keys(hint.data).sort(),['deliveryEpoch','jobId']);assert.equal(hint.data.jobId,f.job.id)}
 let calls=0
 assert.deepEqual(await consume(f,async claim=>{calls++;const before=await f.reader.read(cred(claim)),restored=await freshRead(f,claim);assert.deepEqual(restored.command,command);assert.equal(restored.digest,before.digest);assert.deepEqual(restored.facts,before.facts);await closedExecution(f,claim)},2),[])
 assert.equal(calls,1);assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'failed')
 assert.deepEqual((await f.commands.read(f.alice.token,f.job.id)).command,command)
 assert.equal((await f.files.openFile(f.alice.token,f.file.fileId)).file.revision,f.file.revision)
})

test('PDF acknowledged hint lost in Redis is rebuilt from PostgreSQL and remains non-executable',async t=>{
 const f=await fixture(t);assert.equal(await f.dispatcher.runOnce(),true);await f.queue.queue.obliterate({force:true});assert.equal(await f.queue.queue.getWaitingCount(),0)
 assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'queued');await f.due();await f.dispatcher.runOnce()
 let calls=0;assert.deepEqual(await consume(f,async claim=>{calls++;await closedExecution(f,claim)}),[])
 assert.equal(calls,1);assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).attempts,1)
})

test('PDF forged Redis command is rejected before claim, and a valid opaque hint still recovers',async t=>{
 const f=await fixture(t);await f.queue.queue.add('forged',{jobId:f.job.id,deliveryEpoch:1,command:{...command,operations:[{page:1,degrees:180}]}})
 let calls=0;const errors=await consume(f,async()=>{calls++})
 assert.equal(errors.length,1);assert.equal(calls,0);assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).attempts,0)
 await f.dispatcher.runOnce();assert.deepEqual(await consume(f,async claim=>{calls++;await closedExecution(f,claim)},2),[]);assert.equal(calls,1)
})

for(const fault of ['missing','digest'])test(`PDF ${fault} command after enqueue is refused after real Redis claim, before the closed boundary`,async t=>{
 const f=await fixture(t)
 // Privileged test-owner corruption, not permissions available to a runtime role.
 const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await c.query(fault==='missing'?'DELETE FROM pdf_job_commands WHERE job_id=$1':"UPDATE pdf_job_commands SET command_json=replace(command_json,'90','180'),command_digest=encode(sha256(convert_to(replace(command_json,'90','180'),'UTF8')),'hex') WHERE job_id=$1",[f.job.id]);await c.query('COMMIT')}finally{c.release()}
 await f.dispatcher.runOnce();let calls=0
 assert.deepEqual(await consume(f,async claim=>{calls++;await assert.rejects(f.reader.read(cred(claim)),{code:'PDF_CLAIM_DENIED'});await assert.rejects(f.input.prepare(cred(claim)),{code:'PDF_INPUT_DENIED'});assert.equal(await f.worker.fail(claim,'NATIVE_FAILED',false),true)}),[])
 assert.equal(calls,1);assert.equal((await f.files.openFile(f.alice.token,f.file.fileId)).file.revision,f.file.revision)
})


test('PDF SIGKILLed BullMQ worker is reclaimed after natural claim expiry; fresh reader cannot revive its old claim',{timeout:25000},async t=>{
 const f=await fixture(t);await f.dispatcher.runOnce()
 const child=fork(new URL('../helpers/pdf-claim-worker.mjs',import.meta.url),[],{execPath:process.execPath,execArgv:['--experimental-transform-types'],stdio:['ignore','pipe','pipe','ipc'],env:childEnvironment({worker:f.urls.worker,redis:process.env.DYOFFICE_TEST_REDIS_URL,queue:f.queue.queue.name,deploymentId:f.deploymentId})})
 let output='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.resume()
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited})
 const old=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Disposable worker did not claim')),10000)
  child.once('message',message=>{clearTimeout(timer);if(message.kind==='claimed')resolve(message.claim);else reject(Error('Disposable worker startup failed'))})
  child.once('exit',()=>{clearTimeout(timer);reject(Error('Disposable worker exited before claim'))})
 })
 assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'running')
 child.kill('SIGKILL');assert.deepEqual(await exited,{code:null,signal:'SIGKILL'});assert.equal(output,'')
 // The SQL claim expires naturally; no fabricated expiry or replacement claim.
 await waitFor(async()=>Date.now()>Date.parse(old.leaseUntil)+30)
 await f.due();assert.equal(await f.dispatcher.runOnce(),true)
 let resumed=0
 assert.deepEqual(await consume(f,async claim=>{resumed++;assert.ok(claim.epoch>old.epoch);assert.equal(claim.attempt,old.attempt+1);assert.deepEqual(await freshRead(f,old),{error:'PDF_CLAIM_DENIED'});assert.equal(await f.worker.fail(old,'WORKER_FAILED',false),false);assert.deepEqual((await freshRead(f,claim)).command,command);await closedExecution(f,claim)}),[])
 assert.equal(resumed,1);assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).attempts,2)
})

for(const fault of ['cancel','revoke'])test(`PDF ${fault} after Redis claim blocks command and input preparation before execution`,async t=>{
 const f=await fixture(t);await f.dispatcher.runOnce();let calls=0
 assert.deepEqual(await consume(f,async claim=>{
  calls++;assert.deepEqual((await f.reader.read(cred(claim))).command,command)
  if(fault==='cancel')await f.jobs.cancelJob(f.alice.token,f.job.id);else await f.sessions.logout(f.alice.token)
  await assert.rejects(f.reader.read(cred(claim)),{code:'PDF_CLAIM_DENIED'})
  await assert.rejects(f.input.prepare(cred(claim)),{code:'PDF_INPUT_DENIED'})
 }),[])
 assert.equal(calls,1)
 // Owner-side inspection is fault-test evidence, not revoked-session authority.
 const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);const row=(await c.query('SELECT current_revision FROM files WHERE id=$1',[f.file.fileId])).rows[0];assert.equal(row.current_revision,f.file.revision);assert.equal(Number((await c.query('SELECT count(*) FROM revision_commits WHERE job_id=$1',[f.job.id])).rows[0].count),0);await c.query('COMMIT')}finally{c.release()}
})


test('PDF cancellation after Redis dispatch prevents a claim without deleting the durable command',async t=>{
 const f=await fixture(t);await f.dispatcher.runOnce();await f.jobs.cancelJob(f.alice.token,f.job.id)
 let calls=0;assert.deepEqual(await consume(f,async()=>{calls++}),[])
 assert.equal(calls,0);const job=await f.jobs.getJob(f.alice.token,f.job.id);assert.equal(job.state,'cancelled');assert.equal(job.attempts,0)
 assert.deepEqual((await f.commands.read(f.alice.token,f.job.id)).command,command)
 assert.equal((await f.files.openFile(f.alice.token,f.file.fileId)).file.revision,f.file.revision)
})
