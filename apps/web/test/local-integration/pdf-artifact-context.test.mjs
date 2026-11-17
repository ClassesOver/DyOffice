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
import {createTestPdfInputPreparation} from '../../server/src/pdf/input-preparation.ts'
import {createJobService} from '../../server/src/modules/jobs/service.ts'
let candidate,temporary
before(async()=>{temporary=await mkdtemp(join(tmpdir(),'pdf-pg-fixture-'));candidate=await preparePdfCandidate({sourceRoot:fileURLToPath(new URL('../../../..',import.meta.url)),outputParent:temporary})})
after(async()=>{await rm(temporary,{recursive:true,force:true})})
for(const action of ['success','cancel','takeover','revoke'])test('generated PDF artifact with actual PG pre/post observation: '+action,async t=>{
 const f=await setup(t);await f.register()
 // Explicit synthetic test mapping: hashes correlate candidate bytes only,
 // never turn the candidate into an approved/certified runtime.
 await f.ownerPool.query('UPDATE pdf_runtime_candidates SET runtime_digest=$2 WHERE id=$1',[f.registry.runtimeId,candidate.contentDigest])
 const snapshot=await createTestPdfInputPreparation({transactions:f.transactions,workerPool:f.workerPool,objects:f.objects,deploymentId:f.deploymentId,schema:'public',unsafeTestOnly:true}).prepare(f.cred(f.claim))
 const issued=await f.issuer.issue(f.cred(f.claim),{...f.registry,runtimeVersion:2}),pre=await f.reader.verify(issued.context,f.claim.token)
 assert.deepEqual(snapshot.facts,pre.facts);assert.equal(snapshot.commandDigest,pre.commandDigest);assert.equal(pre.runtimeDigest,candidate.contentDigest)
 const count=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT count(*) FROM uploads)::int uploads,(SELECT count(*) FROM file_revisions)::int revisions,(SELECT count(*) FROM revision_commits)::int commits')).rows[0])
 const baseline=await count();assert.equal(baseline.uploads,1);assert.equal(baseline.revisions,1)
 const binding={contextId:pre.context.id,contextVersion:pre.context.version,jobId:pre.facts.jobId,jobEpoch:pre.facts.jobEpoch,attempt:pre.facts.attempt,fileId:pre.facts.fileId,baseRevision:pre.facts.baseRevision,leaseEpoch:pre.facts.leaseEpoch}
 const pending=runGeneratedPdfCandidateFixture({...candidate,bytes:snapshot.copyBytes(),command:pre.command,binding,unsafeGeneratedFixtureOnly:true})
 // Actual mutations between pre/post checks, without claiming exact scheduling
 // inside pdf-lib execution or authenticating child-reported metadata.
 if(action==='cancel')await createJobService({transactions:f.transactions}).cancelJob(f.alice.token,f.job.id)
 if(action==='takeover')await f.leases.takeoverLease(f.alice.token,f.file.fileId,{editorId:randomUUID(),expectedEpoch:pre.facts.leaseEpoch})
 if(action==='revoke')await f.issuer.revoke(pre.context)
 const result=await pending;assert.equal(result.sha256,createHash('sha256').update(result.bytes).digest('hex'))
 let delivered=false
 const accept=async()=>{const post=await f.reader.verify(pre.context,f.claim.token);assert.deepEqual(post.facts,pre.facts);assert.equal(post.commandDigest,pre.commandDigest);delivered=true}
 if(action==='success'){await accept();assert.equal((await PDFDocument.load(result.bytes)).getPage(0).getRotation().angle,90)}else await assert.rejects(accept())
 assert.equal(delivered,action==='success');assert.deepEqual(await count(),baseline)
})
