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

import {Pool} from 'pg'
import * as context from '../../server/src/pdf/prepared-context.ts'
async function setup(t){
 const f=await fixture(t),job=await f.enqueue(),claim=await f.worker.claim(job.id),observation=await f.controller().prepare(f.cred(claim))
 await f.ownerPool.query(await readFile(new URL('../../worker/src/sandbox/document-unified-authority.candidate.sql',import.meta.url),'utf8'))
 await f.ownerPool.query(await readFile(new URL('../../server/src/pdf/prepared-context.candidate.sql',import.meta.url),'utf8'))
 const issuerName=f.names.owner+'_issuer',secret=randomUUID().replaceAll('-','')
 await f.admin.query(`CREATE ROLE ${issuerName} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`)
 const url=new URL(f.urls.owner);url.username=issuerName;url.password=secret
 const issuerPool=new Pool({connectionString:url.toString()})
 f.cleanup.push(async()=>{await issuerPool.end();await f.ownerPool.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${issuerName}`);await f.ownerPool.query(`REVOKE ALL ON SCHEMA public FROM ${issuerName}`);await f.ownerPool.query(`REVOKE ALL ON DATABASE ${f.database} FROM ${issuerName}`);await f.admin.query(`DROP ROLE ${issuerName}`)})
 await f.ownerPool.query(`GRANT CONNECT ON DATABASE ${f.database} TO ${issuerName}`)
 await f.ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${issuerName}`)
 await f.ownerPool.query(`GRANT EXECUTE ON FUNCTION pdf_issue_prepared_context(uuid,uuid,uuid,bigint,text,uuid,bigint,uuid,bigint),pdf_revoke_prepared_context(uuid,bigint) TO ${issuerName}`)
 await f.ownerPool.query(`GRANT EXECUTE ON FUNCTION pdf_verify_prepared_context(uuid,bigint,text) TO ${f.names.worker}`)
 const scopeId=randomUUID(),runtimeId=randomUUID(),tenantId=randomUUID()
 const registry={scopeId,scopeVersion:1,runtimeId,runtimeVersion:1}
 const register=async()=>{
  await f.ownerPool.query("INSERT INTO document_scope_bindings(id,deployment_id,owner_id,tenant_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 minute')",[scopeId,f.deploymentId,f.alice.user.id,tenantId])
  await f.ownerPool.query("INSERT INTO pdf_runtime_candidates(id,deployment_id,runtime_digest,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 minute')",[runtimeId,f.deploymentId,'c'.repeat(64)])
 }
 const issuer=context.createTestPdfPreparedContextIssuer(issuerPool,{schema:'public',deploymentId:f.deploymentId,unsafeTestOnly:true})
 const reader=context.createTestPdfPreparedContextReader(f.workerPool,{schema:'public',unsafeTestOnly:true})
 return {...f,job,claim,observation,issuerPool,issuerName,registry,tenantId,register,issuer,reader}
}
test('PDF prepared context derives real command/lease and explicit test registry without execution grant',async t=>{
 const f=await setup(t);await f.register()
 const result=await f.issuer.issue(f.cred(f.claim),f.registry)
 assert.equal(result.kind,'command-bound-non-executable');assert.equal(result.facts.jobId,f.job.id)
 assert.equal(result.tenantId,f.tenantId);assert.equal(result.runtimeEnvironment,'test-approved')
 assert.deepEqual(result.command,command);assert.equal(result.commandDigest,f.observation.commandDigest)
 assert.equal('request'in result,false);assert.equal('runtimeGrant'in result,false);assert.equal(JSON.stringify(result).includes(f.claim.token),false)
 const verified=await f.reader.verify(result.context,f.claim.token);assert.deepEqual(verified.facts,result.facts)
 await f.issuer.revoke(result.context);await assert.rejects(f.reader.verify(result.context,f.claim.token))
})
test('missing runtime never inserts context; version changes cannot resurrect prepared context',async t=>{
 const f=await setup(t)
 await assert.rejects(f.issuer.issue(f.cred(f.claim),f.registry))
 assert.equal((await f.ownerPool.query('SELECT count(*)::int n FROM pdf_prepared_contexts')).rows[0].n,0)
 await f.register();const result=await f.issuer.issue(f.cred(f.claim),f.registry)
 await f.ownerPool.query('UPDATE pdf_runtime_candidates SET active=false WHERE id=$1',[f.registry.runtimeId])
 await f.ownerPool.query('UPDATE pdf_runtime_candidates SET active=true WHERE id=$1',[f.registry.runtimeId])
 await assert.rejects(f.reader.verify(result.context,f.claim.token));await assert.rejects(f.issuer.issue(f.cred(f.claim),f.registry))
})
test('fully consistent persisted command rewrite cannot reuse prepared context',async t=>{
 const f=await setup(t);await f.register();const result=await f.issuer.issue(f.cred(f.claim),f.registry)
 const json=JSON.stringify({...command,operations:[{page:1,degrees:180}]}),digest=createHash('sha256').update(json).digest('hex'),requestHash=createHash('sha256').update(JSON.stringify({type:'pdf.rotate',artifactId:f.file.revision,commandDigest:digest})).digest('hex')
 await f.mutate('UPDATE native_jobs SET request_hash=$2 WHERE id=$1',[f.job.id,requestHash]);await f.mutate('UPDATE pdf_job_commands SET command_json=$2,command_digest=$3 WHERE job_id=$1',[f.job.id,json,digest])
 await assert.rejects(f.reader.verify(result.context,f.claim.token))
 assert.deepEqual((await f.issuer.issue(f.cred(f.claim),f.registry)).command.operations,[{page:1,degrees:180}])
})
test('real session revocation and user lease takeover invalidate prepared observations',async t=>{
 const f=await setup(t);await f.register();const result=await f.issuer.issue(f.cred(f.claim),f.registry)
 const editorId=randomUUID(),lease=await f.leases.takeoverLease(f.alice.token,f.file.fileId,{editorId,expectedEpoch:result.facts.leaseEpoch})
 await assert.rejects(f.reader.verify(result.context,f.claim.token))
 assert.equal((await f.leases.getLease(f.alice.token,f.file.fileId)).leaseEpoch,lease.leaseEpoch)
 await f.sessions.logout(f.alice.token);await assert.rejects(f.issuer.issue(f.cred(f.claim),f.registry))
})
test('scope owner mismatch, ABA and foreign PPTX runtime/context never map to PDF',async t=>{
 const f=await setup(t);await f.register()
 await f.ownerPool.query('UPDATE document_scope_bindings SET owner_id=$2 WHERE id=$1',[f.registry.scopeId,f.bob.user.id])
 await assert.rejects(f.issuer.issue(f.cred(f.claim),{...f.registry,scopeVersion:2}))
 await f.ownerPool.query('UPDATE document_scope_bindings SET owner_id=$2 WHERE id=$1',[f.registry.scopeId,f.alice.user.id])
 await assert.rejects(f.issuer.issue(f.cred(f.claim),f.registry))
 const result=await f.issuer.issue(f.cred(f.claim),{...f.registry,scopeVersion:3})
 const pptxId=randomUUID();await f.ownerPool.query("INSERT INTO document_runtime_approvals(id,deployment_id,runtime_digest,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 minute')",[pptxId,f.deploymentId,'a'.repeat(64)])
 await assert.rejects(f.issuer.issue(f.cred(f.claim),{...f.registry,scopeVersion:3,runtimeId:pptxId}))
 // Use owner only to reach each real opposite-kind function, not permission denial.
 await assert.rejects(f.ownerPool.query('SELECT document_verify_context($1,1,$2,\'pre\')',[result.context.id,createHash('sha256').update(f.claim.token).digest('hex')]),{code:'28000'})
 await assert.rejects(f.ownerPool.query('SELECT pdf_verify_prepared_context($1,1,$2)',[randomUUID(),createHash('sha256').update(f.claim.token).digest('hex')]),{code:'28000'})
 await assert.rejects(f.ownerPool.query("INSERT INTO pdf_runtime_candidates(id,deployment_id,profile_id,runtime_digest,expires_at) VALUES($1,$2,'pptx-edit-v1',$3,clock_timestamp()+interval '1 minute')",[randomUUID(),f.deploymentId,'a'.repeat(64)]),{code:'23514'})
})
test('actual restricted issuer/worker permissions and immutable context guards are enforced',async t=>{
 const f=await setup(t);await f.register();const result=await f.issuer.issue(f.cred(f.claim),f.registry)
 for(const pool of [f.workerPool,f.businessPool,f.issuerPool]){
  for(const table of ['pdf_prepared_contexts','pdf_runtime_candidates','document_scope_bindings']){
   await assert.rejects(pool.query(`SELECT * FROM ${table}`),{code:'42501'})
   await assert.rejects(pool.query(`UPDATE ${table} SET active=false`),{code:'42501'})
  }
 }
 await assert.rejects(context.createTestPdfPreparedContextIssuer(f.workerPool,{schema:'public',deploymentId:f.deploymentId,unsafeTestOnly:true}).issue(f.cred(f.claim),f.registry))
 await assert.rejects(context.createTestPdfPreparedContextIssuer(f.businessPool,{schema:'public',deploymentId:f.deploymentId,unsafeTestOnly:true}).issue(f.cred(f.claim),f.registry))
 await assert.rejects(context.createTestPdfPreparedContextReader(f.issuerPool,{schema:'public',unsafeTestOnly:true}).verify(result.context,f.claim.token))
 await assert.rejects(f.workerPool.query('SELECT pdf_revoke_prepared_context($1,1)',[result.context.id]),{code:'42501'})
 await assert.rejects(f.workerPool.query('SELECT pdf_prepared_authority($1,$2,$3,$4)',[f.deploymentId,f.job.id,f.claim.epoch,createHash('sha256').update(f.claim.token).digest('hex')]),{code:'42501'})
 for(const sql of ["UPDATE pdf_prepared_contexts SET command_digest=repeat('a',64)",'DELETE FROM pdf_prepared_contexts','TRUNCATE pdf_prepared_contexts'])await assert.rejects(f.ownerPool.query(sql))
 const audit=(await f.ownerPool.query("SELECT p.proname,p.prosecdef,p.proconfig,r.rolsuper,r.rolbypassrls,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_exec FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('pdf_prepared_authority','pdf_issue_prepared_context','pdf_verify_prepared_context','pdf_revoke_prepared_context')")).rows
 assert.equal(audit.length,4);for(const row of audit){assert.equal(row.prosecdef,true);assert.deepEqual(row.proconfig,['search_path=pg_catalog']);assert.equal(row.rolsuper,false);assert.equal(row.rolbypassrls,false);assert.equal(row.public_exec,false)}
 const login=(await f.issuerPool.query('SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(login.current_user,login.session_user);assert.equal(login.rolsuper,false);assert.equal(login.rolbypassrls,false)
})
test('verify-held context lock serializes revoke, and committed revoke rejects subsequent reads',async t=>{
 const f=await setup(t);await f.register();const result=await f.issuer.issue(f.cred(f.claim),f.registry),worker=await f.workerPool.connect()
 try{
  await worker.query('BEGIN');await worker.query('SELECT pdf_verify_prepared_context($1,1,$2)',[result.context.id,createHash('sha256').update(f.claim.token).digest('hex')])
  const pending=f.issuer.revoke(result.context);let waiting=false;const limit=Date.now()+700
  while(Date.now()<limit){if((await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock'",[f.database,f.issuerName])).rowCount){waiting=true;break}await new Promise(r=>setTimeout(r,5))}
  assert.equal(waiting,true);await worker.query('COMMIT');await pending
  await assert.rejects(f.reader.verify(result.context,f.claim.token))
 }finally{await worker.query('ROLLBACK');worker.release()}
 const next=await f.issuer.issue(f.cred(f.claim),f.registry),issuer=await f.issuerPool.connect()
 try{
  await issuer.query('BEGIN');await issuer.query('SELECT pdf_revoke_prepared_context($1,1)',[next.context.id])
  const pending=assert.rejects(f.reader.verify(next.context,f.claim.token));let waiting=false;const limit=Date.now()+700
  while(Date.now()<limit){if((await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock'",[f.database,f.names.worker])).rowCount){waiting=true;break}await new Promise(r=>setTimeout(r,5))}
  assert.equal(waiting,true);await issuer.query('COMMIT');await pending
 }finally{await issuer.query('ROLLBACK');issuer.release()}
})
test('registry lock wait crosses real expiry and issuance rolls back without inserting a context',async t=>{
 const f=await setup(t);await f.register()
 await f.ownerPool.query("UPDATE pdf_runtime_candidates SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",[f.registry.runtimeId])
 const blocker=await f.ownerPool.connect()
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT * FROM pdf_runtime_candidates WHERE id=$1 FOR UPDATE',[f.registry.runtimeId])
  const pending=assert.rejects(f.issuerPool.query('SELECT pdf_issue_prepared_context($1,$2,$3,$4,$5,$6,1,$7,2)',[randomUUID(),f.deploymentId,f.job.id,f.claim.epoch,createHash('sha256').update(f.claim.token).digest('hex'),f.registry.scopeId,f.registry.runtimeId]),{code:'28000'})
  let waiting=false;const limit=Date.now()+700
  while(Date.now()<limit){if((await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock'",[f.database,f.issuerName])).rowCount){waiting=true;break}await new Promise(r=>setTimeout(r,5))}
  assert.equal(waiting,true)
  while(!(await blocker.query('SELECT expires_at<=clock_timestamp() expired FROM pdf_runtime_candidates WHERE id=$1',[f.registry.runtimeId])).rows[0].expired)await new Promise(r=>setTimeout(r,10))
  await blocker.query('COMMIT');await pending
  assert.equal((await f.ownerPool.query('SELECT count(*)::int n FROM pdf_prepared_contexts')).rows[0].n,0)
 }finally{await blocker.query('ROLLBACK');blocker.release()}
})

test('real worker reclaim invalidates old context and does not silently substitute the new epoch',async t=>{
 const f=await setup(t);await f.register();const result=await f.issuer.issue(f.cred(f.claim),f.registry)
 await f.mutate("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.id])
 const fresh=await f.worker.claim(f.job.id);assert.ok(fresh.epoch>f.claim.epoch)
 await assert.rejects(f.reader.verify(result.context,f.claim.token));await assert.rejects(f.reader.verify(result.context,fresh.token))
 await f.controller().prepare(f.cred(fresh));const next=await f.issuer.issue(f.cred(fresh),f.registry);assert.equal(next.facts.jobEpoch,fresh.epoch)
})
test('actual T06 head advance invalidates context even when native claim is renewed',async t=>{
 const f=await setup(t);await f.register();const result=await f.issuer.issue(f.cred(f.claim),f.registry),editorId=randomUUID()
 const lease=await f.leases.takeoverLease(f.alice.token,f.file.fileId,{editorId,expectedEpoch:result.facts.leaseEpoch}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),bytes=await f.files.readFile(f.alice.token,f.file.fileId,f.file.revision)
 const upload=await revisions.stageUpload(f.alice.token,f.file.fileId,{size:bytes.length,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,editorId});await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
 await revisions.commitRevision(f.alice.token,{fileId:f.file.fileId,uploadId:upload.uploadId,baseRevision:f.file.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.ok(await f.worker.renew(f.claim));await assert.rejects(f.reader.verify(result.context,f.claim.token))
})
test('SQL issuer rejects semantically invalid command even with consistent canonical hashes before insert',async t=>{
 const f=await setup(t);await f.register()
 for(const raw of [{...command,operations:[{page:1,degrees:45}]},{...command,operations:[{page:1,degrees:90},{page:1,degrees:180}]},{...command,operations:[{page:101,degrees:90}]},{...command,operations:[{page:1,degrees:9007199254740992}]},{...command,operations:[{page:1,degrees:90,extra:true}]},{...command,extra:true},JSON.stringify(command,null,2)]){
 const json=typeof raw==='string'?raw:JSON.stringify(raw),digest=createHash('sha256').update(json).digest('hex'),requestHash=createHash('sha256').update(JSON.stringify({type:'pdf.rotate',artifactId:f.file.revision,commandDigest:digest})).digest('hex')
 await f.mutate('UPDATE native_jobs SET request_hash=$2 WHERE id=$1',[f.job.id,requestHash]);await f.mutate('UPDATE pdf_job_commands SET command_json=$2,command_digest=$3 WHERE job_id=$1',[f.job.id,json,digest])
 await assert.rejects(f.issuerPool.query('SELECT pdf_issue_prepared_context($1,$2,$3,$4,$5,$6,1,$7,1)',[randomUUID(),f.deploymentId,f.job.id,f.claim.epoch,createHash('sha256').update(f.claim.token).digest('hex'),f.registry.scopeId,f.registry.runtimeId]))
 assert.equal((await f.ownerPool.query('SELECT count(*)::int n FROM pdf_prepared_contexts')).rows[0].n,0)
 }
})
