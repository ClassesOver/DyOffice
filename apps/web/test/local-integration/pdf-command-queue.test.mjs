import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createTestPdfCommandQueue} from '../../server/src/pdf/command-queue.ts'
const command={version:1,action:'rotatePages',operations:[{page:1,degrees:90}]}
async function fixture(t){
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior})
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create();doc.addPage([200,100]);const file=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'queue.pdf')).file
 await f.ownerPool.query(await readFile(new URL('../../server/src/pdf/command-queue.candidate.sql',import.meta.url),'utf8'))
 await f.ownerPool.query(`GRANT SELECT,INSERT ON pdf_job_commands TO ${f.names.business}`)
 const make=()=>createTestPdfCommandQueue({transactions:f.transactions,unsafeTestOnly:true})
 const counts=()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT count(*) FROM native_jobs)::int jobs,(SELECT count(*) FROM job_outbox)::int outbox,(SELECT count(*) FROM pdf_job_commands)::int commands')).rows[0])
 return {...f,file,make,counts}
}
test('PDF command enqueue is atomic persistent and concurrent-idempotent without execution authority',async t=>{
 const f=await fixture(t),key=randomUUID(),q=f.make(),input={artifactId:f.file.revision,command}
 const [a,b]=await Promise.all([q.enqueue(f.alice.token,input,key),q.enqueue(f.alice.token,input,key)])
 assert.equal(a.id,b.id);assert.deepEqual(await f.counts(),{jobs:1,outbox:1,commands:1})
 const script=`import pg from 'pg';import {createPrincipalTransactions} from './apps/web/server/src/db/context.ts';import {createTestPdfCommandQueue} from './apps/web/server/src/pdf/command-queue.ts';const data=JSON.parse(process.env.PDF_TEST_INPUT);const pool=new pg.Pool({connectionString:data.url});try{const transactions=createPrincipalTransactions({pool,deploymentId:data.deploymentId});console.log(JSON.stringify(await createTestPdfCommandQueue({transactions,unsafeTestOnly:true}).read(data.token,data.id)))}finally{await pool.end()}`
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('../../../../',import.meta.url),env:{...process.env,NODE_ENV:'test',PDF_TEST_INPUT:JSON.stringify({url:f.urls.business,deploymentId:f.deploymentId,token:f.alice.token,id:a.id})}})
 const restored=JSON.parse(stdout)
 assert.deepEqual(restored.command,command);assert.equal(restored.job.id,a.id);assert.equal(restored.job.state,'queued')
 assert.equal('ticket' in restored,false);assert.equal('tenantId' in restored,false)
 await assert.rejects(q.enqueue(f.alice.token,{...input,command:{...command,operations:[{page:1,degrees:180}]}},key),e=>e.statusCode===409)
 assert.deepEqual(await f.counts(),{jobs:1,outbox:1,commands:1})
})
test('PDF queue keeps real owner RLS and rejects revoked sessions and invalid commands',async t=>{
 const f=await fixture(t),q=f.make(),job=await q.enqueue(f.alice.token,{artifactId:f.file.revision,command},randomUUID())
 for(const token of [f.bob.token,f.adminSigned.token]){
  await assert.rejects(q.read(token,job.id),e=>e.statusCode===404)
  await assert.rejects(q.enqueue(token,{artifactId:f.file.revision,command},randomUUID()),e=>e.statusCode===404)
 }
 assert.equal((await f.businessPool.query('SELECT * FROM pdf_job_commands')).rowCount,0)
 await assert.rejects(f.businessPool.query('UPDATE pdf_job_commands SET command_digest=command_digest'),e=>e.code==='42501')
 for(const bad of [{...command,action:'execute'}, {...command,operations:[{page:1,degrees:1}]}, {...command,operations:[{page:1,degrees:90},{page:1,degrees:180}]}])await assert.rejects(q.enqueue(f.alice.token,{artifactId:f.file.revision,command:bad},randomUUID()))
 assert.deepEqual(await f.counts(),{jobs:1,outbox:1,commands:1})
 await f.sessions.logout(f.alice.token);await assert.rejects(q.read(f.alice.token,job.id),e=>e.statusCode===401)
})
test('command insert failure rolls back job and outbox; missing persisted command is never repaired',async t=>{
 const f=await fixture(t),q=f.make(),input={artifactId:f.file.revision,command},key=randomUUID()
 await f.ownerPool.query("CREATE FUNCTION reject_pdf_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$")
 await f.ownerPool.query('CREATE TRIGGER reject_pdf_command BEFORE INSERT ON pdf_job_commands FOR EACH ROW EXECUTE FUNCTION reject_pdf_command()')
 await assert.rejects(q.enqueue(f.alice.token,input,key));assert.deepEqual(await f.counts(),{jobs:0,outbox:0,commands:0})
 await f.ownerPool.query('DROP TRIGGER reject_pdf_command ON pdf_job_commands')
 const a=await q.enqueue(f.alice.token,input,key)
 const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await c.query('DELETE FROM pdf_job_commands WHERE job_id=$1',[a.id]);await c.query('COMMIT')}finally{c.release()}
 await assert.rejects(q.enqueue(f.alice.token,input,key),e=>e.statusCode===409)
 assert.deepEqual(await f.counts(),{jobs:1,outbox:1,commands:0})
})
test('PDF queue is closed outside explicitly selected test mode',async()=>{
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='production';try{assert.throws(()=>createTestPdfCommandQueue({transactions:{},unsafeTestOnly:true}))}finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior}
})
test('consistent owner tampering still conflicts with the frozen job request digest',async t=>{
 const f=await fixture(t),q=f.make(),input={artifactId:f.file.revision,command},key=randomUUID(),job=await q.enqueue(f.alice.token,input,key)
 const text=JSON.stringify({...command,operations:[{page:1,degrees:180}]})
 const c=await f.ownerPool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id]);await c.query("UPDATE pdf_job_commands SET command_json=$2,command_digest=encode(sha256(convert_to($2,'UTF8')),'hex') WHERE job_id=$1",[job.id,text]);await c.query('COMMIT')}finally{c.release()}
 await assert.rejects(q.read(f.alice.token,job.id),e=>e.statusCode===409)
 await assert.rejects(q.enqueue(f.alice.token,input,key),e=>e.statusCode===409)
 assert.deepEqual(await f.counts(),{jobs:1,outbox:1,commands:1})
})
test('PDF queue shares owner quota while replay at capacity remains idempotent',async t=>{
 const f=await fixture(t),q=f.make(),input={artifactId:f.file.revision,command},key=randomUUID(),first=await q.enqueue(f.alice.token,input,key)
 for(let i=1;i<16;i++)await q.enqueue(f.alice.token,input,randomUUID())
 assert.equal((await q.enqueue(f.alice.token,input,key)).id,first.id)
 await assert.rejects(q.enqueue(f.alice.token,input,randomUUID()),e=>e.statusCode===429)
 assert.deepEqual(await f.counts(),{jobs:16,outbox:16,commands:16})
})
test('absent candidate schema fails closed and leaves no shared job or outbox row',async t=>{
 const f=await fixture(t);await f.ownerPool.query('ALTER TABLE pdf_job_commands RENAME TO absent_pdf_commands')
 await assert.rejects(f.make().enqueue(f.alice.token,{artifactId:f.file.revision,command},randomUUID()),e=>e.code==='42P01')
 const rows=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT count(*) FROM native_jobs)::int jobs,(SELECT count(*) FROM job_outbox)::int outbox')).rows[0])
 assert.deepEqual(rows,{jobs:0,outbox:0})
})
