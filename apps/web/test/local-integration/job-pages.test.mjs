import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileFixture,importFile } from '../helpers/files.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { restrictedOrigin } from '../helpers/restricted.mjs'
const url = '/api/v1/jobs'
const headers = (f,token = f.alice.token) => ({ cookie: '__Host-dyoffice-session=' + token,origin: restrictedOrigin,'x-csrf-token': createCsrfService({ db: f.db,deploymentId: f.deploymentId,origin: restrictedOrigin,key: f.csrfKey }).sessionToken(token) })
async function setup(t,nativeJobs = true) {
  const f = await fileFixture(t,{ nativeJobs })
  const file = await importFile(f,f.alice.token,await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url)),'job-route.xlsx')
  return { ...f,file: file.file,payload: { type: 'xlsx.roundtrip',input: { artifactId: file.file.revision },idempotencyKey: randomUUID() } }
}
test('job list pages traverse retained rows beyond 100 with stable equal-time ordering and owner isolation',async t=>{
 const f=await setup(t)
 const job=(await f.app.inject({method:'POST',url,headers:headers(f),payload:f.payload})).json()
 const ids=Array.from({length:105},()=>randomUUID()).sort().reverse()
 for(const id of ids)await f.ownerPool.query(`INSERT INTO native_jobs(id,deployment_id,owner_id,session_id,auth_version,idle_ms,file_id,artifact_id,type,idempotency_key,request_hash,max_attempts,created_at,deadline_at)
 SELECT $1::uuid,deployment_id,owner_id,session_id,auth_version,idle_ms,file_id,artifact_id,type,($1::uuid)::text,request_hash,max_attempts,'2030-01-01T00:00:00.123456Z','2031-01-01' FROM native_jobs WHERE id=$2`,[id,job.id])
 const old=(await f.app.inject({method:'GET',url,headers:headers(f)})).json();assert.equal(old.jobs.length,100);assert.equal(Object.hasOwn(old,'nextCursor'),false)
 let after,seen=[]
 do {const r=await f.app.inject({method:'GET',url:url+'?limit=20'+(after?'&after='+after:''),headers:headers(f)});assert.equal(r.statusCode,200,r.body);const page=r.json();seen.push(...page.jobs.map(j=>j.id));after=page.nextCursor}while(after)
 assert.deepEqual(seen,[...ids,job.id])
 for(const token of [f.bob.token,f.adminSigned.token])assert.equal((await f.app.inject({method:'GET',url:url+'?limit=20&after='+ids[0],headers:headers(f,token)})).statusCode,400)
 for(const query of ['limit=0','limit=101','limit=1.5','after=bad','ownerId='+f.alice.user.id])assert.equal((await f.app.inject({method:'GET',url:url+'?'+query,headers:headers(f)})).statusCode,400)
 await f.sessions.revoke(f.alice.token,f.alice.sessionId)
 assert.equal((await f.app.inject({method:'GET',url:url+'?limit=20',headers:headers(f)})).statusCode,401)
})

test('job cursor preserves microseconds, ignores newly prepended rows and locks its anchor against purge',async t=>{
 const f=await setup(t)
 const job=(await f.app.inject({method:'POST',url,headers:headers(f),payload:f.payload})).json()
 const newer='00000000-0000-4000-8000-000000000001',older='ffffffff-ffff-4fff-8fff-ffffffffffff'
 const insert=async(id,at)=>f.ownerPool.query(`INSERT INTO native_jobs(id,deployment_id,owner_id,session_id,auth_version,idle_ms,file_id,artifact_id,type,idempotency_key,request_hash,max_attempts,created_at,deadline_at)
 SELECT $1::uuid,deployment_id,owner_id,session_id,auth_version,idle_ms,file_id,artifact_id,type,($1::uuid)::text,request_hash,max_attempts,$3::timestamptz,'2031-01-01' FROM native_jobs WHERE id=$2`,[id,job.id,at])
 await insert(newer,'2030-01-01T00:00:00.123457Z');await insert(older,'2030-01-01T00:00:00.123456Z')
 const first=(await f.app.inject({method:'GET',url:url+'?limit=1',headers:headers(f)})).json();assert.equal(first.jobs[0].id,newer);assert.equal(first.nextCursor,newer)
 await insert(randomUUID(),'2030-02-01T00:00:00Z')
 const {createJobService}=await import('../../server/src/modules/jobs/service.ts')
 let signal,release
 const reached=new Promise(r=>signal=r),resume=new Promise(r=>release=r)
 const transactions={...f.transactions,withPrincipalTransaction:(credential,fn)=>f.transactions.withPrincipalTransaction(credential,(c,p)=>fn(new Proxy(c,{get(target,key){if(key==='query')return async(...args)=>{if(String(args[0]).startsWith('SELECT * FROM native_jobs WHERE')){signal();await resume}return target.query(...args)};const value=target[key];return typeof value==='function'?value.bind(target):value}}),p))}
 const pending=createJobService({transactions}).listJobPage(f.alice.token,{limit:1,after:newer})
 const owner=await f.ownerPool.connect()
 try {
  await reached;await owner.query("SET lock_timeout='100ms'")
  await assert.rejects(()=>owner.query('DELETE FROM native_jobs WHERE id=$1',[newer]),{code:'55P03'})
 } finally {release();await owner.query('RESET lock_timeout');owner.release()}
 const second=await pending;assert.equal(second.jobs[0].id,older);assert.equal(second.nextCursor,older)
 await f.ownerPool.query('DELETE FROM native_jobs WHERE id=$1',[newer])
 assert.equal((await f.app.inject({method:'GET',url:url+'?after='+newer,headers:headers(f)})).statusCode,400)
})
