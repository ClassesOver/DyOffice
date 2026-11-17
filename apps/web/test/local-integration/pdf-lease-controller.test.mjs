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
async function fixture(t){
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior})
 const f=await fileFixture(t,{buildApp:false,worker:true}),doc=await PDFDocument.create();doc.addPage([200,100]);const file=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'claim.pdf')).file
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
test('real PDF claim acquires a bound edit lease and repeated preparation observes the same live epoch',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),controller=f.controller()
 const [one,two]=await Promise.all([controller.prepare(f.cred(claim)),controller.prepare(f.cred(claim))])
 assert.deepEqual(one.command,command);assert.equal(one.facts.editorId,job.id);assert.equal(one.facts.jobEpoch,claim.epoch)
 assert.equal(one.facts.leaseEpoch,two.facts.leaseEpoch);assert.ok(one.remainingMs>0)
 assert.equal(JSON.stringify(one).includes(claim.token),false);assert.equal('runtimeGrant' in one,false)
 const actual=await f.leases.getLease({kind:'job',jobId:claim.jobId,epoch:claim.epoch,token:claim.token},f.file.fileId)
 assert.equal(actual.active,true);assert.equal(actual.leaseEpoch,one.facts.leaseEpoch)
 await f.verify.verify(one.facts,claim.token)
})
test('different PDF jobs cannot share a lease; user takeover is never reclaimed by the controller',async t=>{
 const f=await fixture(t),a=await f.enqueue(),b=await f.enqueue(),ca=await f.worker.claim(a.id),cb=await f.worker.claim(b.id),controller=f.controller()
 const results=await Promise.allSettled([controller.prepare(f.cred(ca)),controller.prepare(f.cred(cb))])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 const index=results.findIndex(r=>r.status==='fulfilled'),evidence=results[index].value,claim=[ca,cb][index]
 const editorId=randomUUID(),owned=await f.leases.takeoverLease(f.alice.token,f.file.fileId,{editorId,expectedEpoch:evidence.facts.leaseEpoch})
 await assert.rejects(f.verify.verify(evidence.facts,claim.token))
 await assert.rejects(controller.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
 const current=await f.leases.getLease(f.alice.token,f.file.fileId);assert.equal(current.editorId,editorId);assert.equal(current.leaseEpoch,owned.leaseEpoch)
})
test('natural edit-lease expiry invalidates old evidence and fresh preparation obtains a newer real epoch',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),controller=f.controller(650),one=await controller.prepare(f.cred(claim))
 const auth={kind:'job',...f.cred(claim)},deadline=Date.now()+3000
 while((await f.leases.getLease(auth,f.file.fileId)).active){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,20))}
 await assert.rejects(f.verify.verify(one.facts,claim.token))
 const next=await controller.prepare(f.cred(claim));assert.ok(next.facts.leaseEpoch>one.facts.leaseEpoch)
})
test('session revocation after a lease observation rejects both old evidence and new preparation',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),controller=f.controller(),one=await controller.prepare(f.cred(claim))
 await f.sessions.logout(f.alice.token)
 await assert.rejects(f.verify.verify(one.facts,claim.token));await assert.rejects(controller.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
})
test('a real T06 head advance invalidates a claimed PDF despite a renewed worker claim',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),controller=f.controller(),one=await controller.prepare(f.cred(claim))
 const editorId=randomUUID(),lease=await f.leases.takeoverLease(f.alice.token,f.file.fileId,{editorId,expectedEpoch:one.facts.leaseEpoch}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),bytes=await f.files.readFile(f.alice.token,f.file.fileId,f.file.revision)
 const upload=await revisions.stageUpload(f.alice.token,f.file.fileId,{size:bytes.length,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,editorId});await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
 await revisions.commitRevision(f.alice.token,{fileId:f.file.fileId,uploadId:upload.uploadId,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.ok(await f.worker.renew(claim));await assert.rejects(f.verify.verify(one.facts,claim.token));await assert.rejects(controller.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
})
test('reclaimed native epoch cannot reuse previous controller input',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),controller=f.controller(),one=await controller.prepare(f.cred(claim))
 await f.mutate("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id])
 const next=await f.worker.claim(job.id);assert.ok(next.epoch>claim.epoch)
 await assert.rejects(controller.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
 const fresh=await controller.prepare(f.cred(next));assert.equal(fresh.facts.jobEpoch,next.epoch);assert.ok(fresh.facts.leaseEpoch>one.facts.leaseEpoch)
})
test('command mutation while real lease acquisition waits is rejected without releasing the shared lease',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),controller=f.controller(),first=await controller.prepare(f.cred(claim))
 const blocker=await f.ownerPool.connect()
 try{
  await blocker.query('BEGIN');await blocker.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await blocker.query('SELECT * FROM edit_leases WHERE file_id=$1 FOR UPDATE',[f.file.fileId])
  const pending=assert.rejects(controller.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
  const deadline=Date.now()+2500;let waiting=false
  while(Date.now()<deadline){const rows=await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'",[f.database,f.businessPool.options.application_name]);if(rows.rowCount){waiting=true;break}await new Promise(r=>setTimeout(r,5))}
  assert.equal(waiting,true,'observe controller business lease acquisition waiting')
  const text=JSON.stringify({...command,operations:[{page:1,degrees:180}]})
  const mutationStarted=Date.now()
  await f.mutate("UPDATE pdf_job_commands SET command_json=$2,command_digest=encode(sha256(convert_to($2,'UTF8')),'hex') WHERE job_id=$1",[job.id,text])
  assert.ok(Date.now()-mutationStarted<2000,'command mutation must precede lease acquisition timeout')
  await blocker.query('COMMIT');await pending
  const lease=await f.leases.getLease({kind:'job',...f.cred(claim)},f.file.fileId);assert.equal(lease.active,true);assert.equal(lease.leaseEpoch,first.facts.leaseEpoch)
 }finally{await blocker.query('ROLLBACK');blocker.release()}
})
test('unavailable verifier after acquisition does not release a successful same-claim lease',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),first=await f.controller().prepare(f.cred(claim))
 const unavailable=createTestPdfLeaseController({transactions:f.transactions,workerPool:f.workerPool,deploymentId:f.deploymentId,schema:'missing_pdf_authority',unsafeTestOnly:true})
 await assert.rejects(unavailable.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
 const actual=await f.leases.getLease({kind:'job',...f.cred(claim)},f.file.fileId);assert.equal(actual.active,true);assert.equal(actual.leaseEpoch,first.facts.leaseEpoch)
 await f.verify.verify(first.facts,claim.token)
})
test('claim is captured before await and production or wrong-role assembly fails closed',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),raw=f.cred(claim),controller=f.controller(),pending=controller.prepare(raw)
 raw.jobId=randomUUID();raw.token='x'.repeat(43);raw.epoch++
 assert.equal((await pending).facts.jobId,job.id)
 const wrong=createTestPdfLeaseController({transactions:f.transactions,workerPool:f.businessPool,deploymentId:f.deploymentId,schema:'public',unsafeTestOnly:true})
 await assert.rejects(wrong.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='production'
 try{assert.throws(()=>f.controller(),{code:'PDF_LEASE_DENIED'});await assert.rejects(controller.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})}finally{process.env.NODE_ENV=prior}
})

test('consistent persisted command rewrite passes both real readers but controller rejects changed digest',async t=>{
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id)
 const rewritten={...command,operations:[{page:1,degrees:180}]},json=JSON.stringify(rewritten),digest=createHash('sha256').update(json).digest('hex')
 const requestHash=createHash('sha256').update(JSON.stringify({type:'pdf.rotate',artifactId:f.file.revision,commandDigest:digest})).digest('hex')
 const seen=[];let nativeReads=0,rewrote=false
 // Test scheduling only: every query and role check uses the real restricted
 // worker connection. Pause AFTER COMMIT, so no job/file locks remain held.
 const pool=new Proxy(f.workerPool,{get(target,key){
  if(key==='connect')return async()=>{
   const client=await target.connect();let reader=false
   return new Proxy(client,{get(c,k){
    if(k==='query')return async(...args)=>{
     const result=await c.query(...args),sql=args[0]
     if(typeof sql==='string'&&sql.includes('SELECT read_pdf_claim_command(')){reader=true;seen.push(result.rows[0].value.digest)}
     if(typeof sql==='string'&&sql.includes('document_native_authority('))nativeReads++
     if(sql==='COMMIT'&&reader&&!rewrote){
      rewrote=true
      const owner=await f.ownerPool.connect()
      try{
       await owner.query('BEGIN')
       await owner.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
       assert.equal((await owner.query('UPDATE native_jobs SET request_hash=$2 WHERE id=$1',[job.id,requestHash])).rowCount,1)
       assert.equal((await owner.query('UPDATE pdf_job_commands SET command_json=$2,command_digest=$3 WHERE job_id=$1',[job.id,json,digest])).rowCount,1)
       await owner.query('COMMIT')
      }catch(error){await owner.query('ROLLBACK');throw error}finally{owner.release()}
     }
     return result
    }
    const value=Reflect.get(c,k,c);return typeof value==='function'?value.bind(c):value
   }})
  }
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
 }})
 const controller=createTestPdfLeaseController({transactions:f.transactions,workerPool:pool,deploymentId:f.deploymentId,schema:'public',unsafeTestOnly:true})
 await assert.rejects(controller.prepare(f.cred(claim)),{code:'PDF_LEASE_DENIED'})
 assert.equal(rewrote,true);assert.equal(seen.length,2);assert.notEqual(seen[0],digest);assert.equal(seen[1],digest)
 assert.equal(nativeReads,1,'changed digest rejects before the final authority verification')
 const lease=await f.leases.getLease({kind:'job',...f.cred(claim)},f.file.fileId)
 assert.equal(lease.active,true,'failed observer must not release the shared lease')
 // A new unproxied controller accepts the new consistent persisted command:
 // denial above is not a permanently malformed row or fake reader response.
 const fresh=await f.controller().prepare(f.cred(claim));assert.deepEqual(fresh.command,rewritten);assert.equal(fresh.commandDigest,digest)
})
