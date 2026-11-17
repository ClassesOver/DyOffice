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

import {before,after} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {preparePdfCandidate} from '../../scripts/prepare-pdf-runtime-candidate.mjs'
import {runGeneratedPdfCandidateFixture} from '../helpers/pdf-candidate-fixture.mjs'
import {createTestPdfPreparedPackage} from '../../server/src/pdf/prepared-package.ts'
let candidate,temporary
before(async()=>{temporary=await mkdtemp(join(tmpdir(),'pdf-package-'));candidate=await preparePdfCandidate({sourceRoot:fileURLToPath(new URL('../../../..',import.meta.url)),outputParent:temporary})})
after(async()=>{await rm(temporary,{recursive:true,force:true})})
async function packageFixture(t){
 const f=await setup(t);await f.register();await f.ownerPool.query('UPDATE pdf_runtime_candidates SET runtime_digest=$2 WHERE id=$1',[f.registry.runtimeId,candidate.contentDigest])
 const options={transactions:f.transactions,workerPool:f.workerPool,issuerPool:f.issuerPool,objects:f.objects,deploymentId:f.deploymentId,schema:'public',expectedArtifactDigest:candidate.contentDigest,unsafeTestOnly:true}
 return {...f,options,registry:{...f.registry,runtimeVersion:2},package:()=>createTestPdfPreparedPackage(options)}
}
const counts=f=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT count(*) FROM uploads)::int uploads,(SELECT count(*) FROM file_revisions)::int revisions,(SELECT count(*) FROM revision_commits)::int commits')).rows[0])
async function executePrepared(p,override){const {requestId,inputSha256,inputSize,commandDigest,...binding}=p.binding;return runGeneratedPdfCandidateFixture({...candidate,requestId:override===undefined?requestId:override,bytes:p.copyInput(),command:p.command,binding,unsafeGeneratedFixtureOnly:true})}
test('real prepared package binds PG input/context to generated artifact and accepts once after recheck',async t=>{
 const f=await packageFixture(t),before=await counts(f),p=await f.package().prepare(f.cred(f.claim),f.registry)
 assert.equal(p.scope,'pdf-nonexecutable-prepared-package');assert.equal(p.binding.contextId,p.context.id)
 const copy=p.copyInput();copy.fill(0);assert.notDeepEqual(p.copyInput(),copy)
 await assert.rejects(executePrepared(p,null));await assert.rejects(executePrepared(p,'invalid-nonce'))
 const result=await executePrepared(p);assert.equal(result.binding.requestId,p.binding.requestId)
 const accepted=await p.acceptFixtureOutput(result)
 assert.equal(accepted.scope,'pdf-fixture-output-observation');assert.equal((await PDFDocument.load(accepted.bytes)).getPage(0).getRotation().angle,90)
 await assert.rejects(p.acceptFixtureOutput(result));assert.deepEqual(await counts(f),before)
})
test('real context revocation after child output rejects acceptance and never writes T06',async t=>{
 const f=await packageFixture(t),before=await counts(f),p=await f.package().prepare(f.cred(f.claim),f.registry),result=await executePrepared(p)
 await f.issuer.revoke(p.context);await assert.rejects(p.acceptFixtureOutput(result));assert.deepEqual(await counts(f),before)
})
test('mismatched externally pinned artifact digest cannot yield a prepared package',async t=>{
 const f=await packageFixture(t)
 await assert.rejects(createTestPdfPreparedPackage({...f.options,expectedArtifactDigest:'0'.repeat(64)}).prepare(f.cred(f.claim),f.registry))
})
test('real consistent command change after input final commit cannot be paired with newer context',async t=>{
 const f=await packageFixture(t);let nativeCommits=0,changed=false
 const pool=new Proxy(f.workerPool,{get(target,key){if(key==='connect')return async()=>{
  const c=await target.connect();let native=false
  return new Proxy(c,{get(client,k){if(k==='query')return async(...a)=>{
   const result=await client.query(...a);if(typeof a[0]==='string'&&a[0].includes('document_native_authority('))native=true
   if(a[0]==='COMMIT'&&native&&++nativeCommits===4){
    const json=JSON.stringify({...command,operations:[{page:1,degrees:180}]}),digest=createHash('sha256').update(json).digest('hex'),requestHash=createHash('sha256').update(JSON.stringify({type:'pdf.rotate',artifactId:f.file.revision,commandDigest:digest})).digest('hex')
    await f.mutate('UPDATE native_jobs SET request_hash=$2 WHERE id=$1',[f.job.id,requestHash]);await f.mutate('UPDATE pdf_job_commands SET command_json=$2,command_digest=$3 WHERE job_id=$1',[f.job.id,json,digest]);changed=true
   }return result
  };const v=Reflect.get(client,k,client);return typeof v==='function'?v.bind(client):v}})
 };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v}})
 await assert.rejects(createTestPdfPreparedPackage({...f.options,workerPool:pool}).prepare(f.cred(f.claim),f.registry))
 assert.equal(changed,true);assert.equal(nativeCommits,4)
 assert.equal((await f.ownerPool.query('SELECT count(*)::int n FROM pdf_prepared_contexts')).rows[0].n,1,'issuer succeeds but package rejects old input command versus new context')
 assert.deepEqual((await f.issuer.issue(f.cred(f.claim),f.registry)).command.operations,[{page:1,degrees:180}])
 assert.deepEqual(await counts(f),{uploads:1,revisions:1,commits:0})
})
test('real revoke immediately after issuer commit rejects the package before delivery',async t=>{
 const f=await packageFixture(t);let revoked=false
 const pool=new Proxy(f.issuerPool,{get(target,key){if(key==='connect')return async()=>{
  const c=await target.connect();let ref
  return new Proxy(c,{get(client,k){if(k==='query')return async(...a)=>{const result=await client.query(...a);if(typeof a[0]==='string'&&a[0].includes('pdf_issue_prepared_context('))ref=result.rows[0].value.context;if(a[0]==='COMMIT'&&ref){await f.issuer.revoke(ref);revoked=true}return result};const v=Reflect.get(client,k,client);return typeof v==='function'?v.bind(client):v}})
 };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v}})
 await assert.rejects(createTestPdfPreparedPackage({...f.options,issuerPool:pool}).prepare(f.cred(f.claim),f.registry));assert.equal(revoked,true)
 const rows=(await f.ownerPool.query('SELECT active FROM pdf_prepared_contexts')).rows;assert.equal(rows.length,1);assert.equal(rows[0].active,false)
})
test('output is captured before await and two concurrent accepts cannot both succeed',async t=>{
 const f=await packageFixture(t),raw=f.cred(f.claim),registry={...f.registry},pending=f.package().prepare(raw,registry)
 raw.jobId=randomUUID();raw.epoch++;registry.runtimeId=randomUUID()
 const p=await pending;assert.equal(p.binding.jobId,f.job.id)
 const result=await executePrepared(p),original=Buffer.from(result.bytes),first=p.acceptFixtureOutput(result)
 assert.throws(()=>p.copyInput());result.bytes.fill(0)
 const outcomes=await Promise.allSettled([first,p.acceptFixtureOutput(result)])
 assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].status,'rejected');assert.deepEqual(outcomes[0].value.bytes,original)
})
test('wrong output tuple consumes package and cannot be retried with the correct result',async t=>{
 const f=await packageFixture(t),p=await f.package().prepare(f.cred(f.claim),f.registry),result=await executePrepared(p)
 await assert.rejects(p.acceptFixtureOutput({...result,binding:{...result.binding,requestId:randomUUID()}}))
 await assert.rejects(p.acceptFixtureOutput(result));assert.throws(()=>p.copyInput())
})
test('unknown issue response leaves one non-executable context without replay or guessed cleanup',async t=>{
 const f=await packageFixture(t);let calls=0
 const pool=new Proxy(f.issuerPool,{get(target,key){if(key==='connect')return async()=>{
  const c=await target.connect();let issued=false
  return new Proxy(c,{get(client,k){if(k==='query')return async(...a)=>{const result=await client.query(...a);if(typeof a[0]==='string'&&a[0].includes('pdf_issue_prepared_context(')){issued=true;calls++}if(a[0]==='COMMIT'&&issued)throw Error('synthetic lost commit response');return result};const v=Reflect.get(client,k,client);return typeof v==='function'?v.bind(client):v}})
 };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v}})
 await assert.rejects(createTestPdfPreparedPackage({...f.options,issuerPool:pool}).prepare(f.cred(f.claim),f.registry))
 const rows=(await f.ownerPool.query('SELECT kind,active FROM pdf_prepared_contexts')).rows;assert.equal(calls,1);assert.equal(rows.length,1);assert.equal(rows[0].kind,'command-bound-non-executable');assert.equal(rows[0].active,true)
})
test('package signal cancellation before preparation or after fixture output fails closed without T06',async t=>{
 const f=await packageFixture(t),before=await counts(f),early=new AbortController();early.abort()
 await assert.rejects(f.package().prepare(f.cred(f.claim),f.registry,{signal:early.signal}))
 assert.equal((await f.ownerPool.query('SELECT count(*)::int n FROM pdf_prepared_contexts')).rows[0].n,0)
 const later=new AbortController(),p=await f.package().prepare(f.cred(f.claim),f.registry,{signal:later.signal}),result=await executePrepared(p)
 later.abort();await assert.rejects(p.acceptFixtureOutput(result));await assert.rejects(p.acceptFixtureOutput(result));assert.throws(()=>p.copyInput())
 assert.deepEqual(await counts(f),before)
})
