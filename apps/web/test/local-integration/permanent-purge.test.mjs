import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileFixture as localFileFixture,docxBytes,importFile } from '../helpers/files.mjs'

import { s3Fixture } from '../helpers/s3.mjs'
async function fileFixture(t,options={}) {
 if (process.env.DYOFFICE_TEST_RECLAMATION_STORE !== 's3') return localFileFixture(t,options)
 const {store,bucket}=await s3Fixture(t)
 return {...await localFileFixture(t,{...options,objectStore:store}),s3Bucket:bucket}
}

test('permanent purge requires own trash, commits an irreversible fence and credits removed objects once',async t=>{
 const f=await fileFixture(t),bytes=await docxBytes(),created=await importFile(f,f.alice.token,bytes),id=created.file.fileId
 assert.equal(typeof f.files.purgeFile,'function')
 await assert.rejects(()=>f.files.purgeFile(f.alice.token,id),{statusCode:409})
 await f.files.trashFile(f.alice.token,id)
 await assert.rejects(()=>f.files.purgeFile(f.bob.token,id),{statusCode:404})
 const result=await f.files.purgeFile(f.alice.token,id)
 assert.equal(result.state,'purged')
 assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
 await assert.rejects(()=>f.files.restoreFile(f.alice.token,id))
 await assert.rejects(()=>f.files.readFile(f.alice.token,id,created.file.revision))
 assert.equal((await f.files.listFiles(f.alice.token,{trash:true})).files.length,0)
 assert.equal((await f.files.purgeFile(f.alice.token,id)).state,'purged')
 assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
})

import { randomUUID } from 'node:crypto'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
import { createJobWorkerStore } from '../../server/src/modules/jobs/worker-store.ts'
import { jobFixture } from '../helpers/jobs.mjs'
const owned=(f,fn)=>f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},fn)
async function savedFixture(t,options={}) {
 const f=await fileFixture(t,{...options,worker:true}),bytes=await docxBytes(),initial=(await importFile(f,f.alice.token,bytes)).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 const draft=await revisions.stageUpload(f.alice.token,initial.fileId,{size:bytes.length,baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,editorId})
 await f.files.receiveUpload(f.alice.token,draft.uploadId,bytes)
 const input={fileId:initial.fileId,uploadId:draft.uploadId,baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()}
 const saved=await revisions.commitRevision(f.alice.token,input)
 return {...f,bytes,initial,saved,revisions,input,leases,editorId}
}
test('purge retires held outbox delivery, fences receipts and preserves immutable audit identities',async t=>{
 const f=await savedFixture(t),id=f.initial.fileId,worker=createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId})
 const delivery=await worker.takeRevisionDelivery();assert.ok(delivery)
 await f.files.trashFile(f.alice.token,id)
 assert.equal((await f.files.purgeFile(f.alice.token,id)).state,'pending')
 assert.equal(await worker.ackRevisionDelivery(delivery),false)
 assert.equal(await worker.takeRevisionDelivery(),null)
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,f.input),{statusCode:410})
 await assert.rejects(()=>f.revisions.listRevisions(f.alice.token,id))
 await assert.rejects(()=>f.leases.acquireLease(f.alice.token,id,{editorId:randomUUID()}))
 assert.equal((await f.files.purgeFile(f.alice.token,id)).state,'purged')
 const state=await owned(f,async c=>({refs:(await c.query('SELECT * FROM file_revisions')).rows,receipts:(await c.query('SELECT * FROM revision_commits')).rows,event:(await c.query('SELECT * FROM revision_outbox')).rows[0]}))
 assert.equal(state.refs.length,2);assert.ok(state.refs.every(r=>r.reclaimed_at));assert.equal(state.receipts.length,1)
 assert.ok(state.event.retired_at);assert.equal(state.event.published_at,null)
 await assert.rejects(()=>owned(f,c=>c.query('UPDATE file_revisions SET size=size+1')),{code:'42501'})
 await assert.rejects(()=>owned(f,c=>c.query('UPDATE files SET purge_started_at=NULL,deleted_at=NULL')),{code:'23514'})
 assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
})
test('receipt replay waits behind concurrent durable purge and rejects its tombstone', {timeout:20000}, async t=>{
 let enter,release
 const entered=new Promise(resolve=>{enter=resolve}),hold=new Promise(resolve=>{release=resolve})
 const f=await savedFixture(t,{wrapObjects:store=>({...store,async removeUnreferenced(key){enter();await hold;return store.removeUnreferenced(key)}})})
 await f.files.trashFile(f.alice.token,f.initial.fileId)
 const purging=f.files.purgeFile(f.alice.token,f.initial.fileId).then(value=>({value}),error=>({error}))
 let replay
 try{
  await Promise.race([entered,purging.then(()=>{throw Error('Purge ended before delete barrier')})])
  replay=f.revisions.commitRevision(f.alice.token,f.input).then(value=>({value}),error=>({error}))
  const {waitForDatabaseLock}=await import('../helpers/restricted.mjs')
  await waitForDatabaseLock(f,'business')
  release()
  assert.equal((await purging).value?.state,'pending','purge reclaims one of the two revisions per call')
  assert.equal((await replay).error?.statusCode,410)
  assert.equal((await f.files.purgeFile(f.alice.token,f.initial.fileId)).state,'purged')
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
  assert.equal((await owned(f,c=>c.query('SELECT * FROM revision_commits'))).rowCount,1)
 }finally{release();await purging;if(replay)await replay}
})

test('purge refuses active jobs and stale enqueue receipts cannot advertise a purged artifact',async t=>{
 const f=await jobFixture(t),key=randomUUID(),job=await f.jobs.enqueueJob(f.alice.token,'docx.roundtrip',f.input,key)
 await f.files.trashFile(f.alice.token,f.fileId)
 await assert.rejects(()=>f.files.purgeFile(f.alice.token,f.fileId),{statusCode:409})
 await f.jobs.cancelJob(f.alice.token,job.id)
 assert.equal((await f.files.purgeFile(f.alice.token,f.fileId)).state,'purged')
 await assert.rejects(()=>f.jobs.enqueueJob(f.alice.token,'docx.roundtrip',f.input,key),{statusCode:410})
})

import { createFileService } from '../../server/src/modules/files/service.ts'
test('purge storage failure commits fence but retains bytes and post-delete rollback retries once',async t=>{
 let offline=true,failCommit=true,removed=0
 const f=await fileFixture(t,{wrapObjects:store=>({...store,removeUnreferenced:async key=>{if(offline)throw Error('offline');await store.removeUnreferenced(key);removed++}})})
 const bytes=await docxBytes(),id=(await importFile(f,f.alice.token,bytes)).file.fileId
 await f.files.trashFile(f.alice.token,id)
 assert.equal((await f.files.purgeFile(f.alice.token,id)).state,'pending')
 assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length)
 await assert.rejects(()=>f.files.restoreFile(f.alice.token,id))
 offline=false
 const transactions={withPrincipalTransaction:(input,fn)=>f.transactions.withPrincipalTransaction(input,async(c,p)=>{const result=await fn(c,p);if(failCommit&&result?.state==='purged')throw Error('after delete rollback');return result})}
 const files=createFileService({transactions,objects:f.objects})
 await assert.rejects(()=>files.purgeFile(f.alice.token,id),/after delete rollback/)
 assert.equal(removed,1);assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length)
 failCommit=false
 assert.equal((await files.purgeFile(f.alice.token,id)).state,'purged')
 assert.equal(removed,2);assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
 await files.purgeFile(f.alice.token,id);assert.equal(removed,2)
})
test('concurrent purge and restore serialize after committed retirement without duplicate refund',async t=>{
 let enter,release;const entered=new Promise(r=>{enter=r}),hold=new Promise(r=>{release=r});let removed=0
 const f=await fileFixture(t,{wrapObjects:store=>({...store,removeUnreferenced:async key=>{removed++;enter();await hold;await store.removeUnreferenced(key)}})})
 const bytes=await docxBytes(),id=(await importFile(f,f.alice.token,bytes)).file.fileId
 await f.files.trashFile(f.alice.token,id)
 const first=f.files.purgeFile(f.alice.token,id);await entered
 const second=f.files.purgeFile(f.alice.token,id)
 const restore=f.files.restoreFile(f.alice.token,id).then(()=>true,()=>false)
 const {waitForDatabaseLock}=await import('../helpers/restricted.mjs')
 try {await waitForDatabaseLock(f,'business')} finally {release()}
 assert.equal((await first).state,'purged');assert.equal((await second).state,'purged');assert.equal(await restore,false)
 assert.equal(removed,1);assert.equal((await f.files.usage(f.alice.token)).storedBytes,0)
})
test('expired receiving drafts with unresolved late writes block permanent purge and retain charges',async t=>{
 const f=await savedFixture(t),id=f.initial.fileId,lease=await f.leases.acquireLease(f.alice.token,id,{editorId:f.editorId})
 const draft=await f.revisions.stageUpload(f.alice.token,id,{size:f.bytes.length,baseRevision:f.saved.revision,leaseEpoch:lease.leaseEpoch,editorId:f.editorId})
 await owned(f,c=>c.query("UPDATE uploads SET state='receiving',attempt_id=$2,created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[draft.uploadId,randomUUID()]))
 await f.files.trashFile(f.alice.token,id)
 await assert.rejects(()=>f.files.purgeFile(f.alice.token,id),{statusCode:409})
 await f.files.restoreFile(f.alice.token,id)
 assert.deepEqual(await f.files.readFile(f.alice.token,id,f.saved.revision),f.bytes)
 assert.equal((await f.files.usage(f.alice.token)).storedBytes,f.bytes.length*3)
})

test('permanent purge process exit after deletion preserves committed fence and retries accounting',async t=>{
 const f=await fileFixture(t),bytes=await docxBytes(),token=f.alice.token,id=(await importFile(f,token,bytes)).file.fileId
 await f.files.trashFile(token,id)
 const {spawn}=await import('node:child_process')
 const code=`
 import {Pool} from 'pg';
 import {S3Client} from '@aws-sdk/client-s3';
 import {createPrincipalTransactions} from './apps/web/server/src/db/context.ts';
 import {createFileService} from './apps/web/server/src/modules/files/service.ts';
 import {createLocalObjectStore} from './apps/web/server/src/storage/local-dev.ts';
 import {createS3ObjectStore} from './apps/web/server/src/storage/s3.ts';
 const pool=new Pool({connectionString:process.env.GC_TEST_DB});
 const base=createPrincipalTransactions({pool,deploymentId:process.env.GC_TEST_DEPLOYMENT});
 const objects=process.env.GC_TEST_BUCKET ? createS3ObjectStore({bucket:process.env.GC_TEST_BUCKET,client:new S3Client({endpoint:process.env.DYOFFICE_TEST_S3_ENDPOINT,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.DYOFFICE_TEST_S3_ACCESS_KEY,secretAccessKey:process.env.DYOFFICE_TEST_S3_SECRET_KEY}})}) : await createLocalObjectStore({directory:process.env.GC_TEST_DIRECTORY});
 const transactions={withPrincipalTransaction:(input,fn)=>base.withPrincipalTransaction(input,async(c,p)=>{const result=await fn(c,p);if(result?.state==='purged')process.exit(77);return result})};
 await createFileService({transactions,objects}).purgeFile(process.env.GC_TEST_TOKEN,process.env.GC_TEST_FILE);
 await pool.end();process.exit(0);
 `
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{cwd:new URL('../../../..',import.meta.url),env:{...process.env,GC_TEST_DB:f.urls.business,GC_TEST_DEPLOYMENT:f.deploymentId,GC_TEST_TOKEN:token,GC_TEST_FILE:id,GC_TEST_DIRECTORY:f.directory,...(f.s3Bucket?{GC_TEST_BUCKET:f.s3Bucket}:{})},stdio:['ignore','ignore','pipe']})
 let errors='';child.stderr.on('data',data=>{errors+=data})
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 assert.equal(exit,77,errors)
 assert.equal((await f.files.usage(token)).storedBytes,bytes.length)
 await assert.rejects(()=>f.files.restoreFile(token,id))
 assert.equal((await f.files.purgeFile(token,id)).state,'purged')
 assert.equal((await f.files.usage(token)).storedBytes,0)
})

import { restrictedOrigin,waitForDatabaseLock } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
const headers=(f,token=f.alice.token)=>({origin:restrictedOrigin,cookie:'__Host-dyoffice-session='+token,'x-csrf-token':createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey}).sessionToken(token)})
test('explicit purge HTTP action enforces CSRF, strict input and owner boundaries',async t=>{
 const f=await fileFixture(t),id=(await importFile(f,f.alice.token,await docxBytes())).file.fileId,url=`/api/v1/files/${id}/purge`
 await f.files.trashFile(f.alice.token,id)
 assert.equal((await f.app.inject({method:'POST',url})).statusCode,401)
 assert.equal((await f.app.inject({method:'POST',url,headers:{cookie:headers(f).cookie,origin:restrictedOrigin}})).statusCode,403)
 assert.equal((await f.app.inject({method:'POST',url,headers:headers(f,f.bob.token)})).statusCode,404)
 assert.equal((await f.app.inject({method:'POST',url,headers:headers(f,f.adminSigned.token)})).statusCode,404)
 assert.equal((await f.app.inject({method:'POST',url,headers:headers(f),payload:{confirm:true}})).statusCode,400)
 assert.equal((await f.app.inject({method:'POST',url:url+'?owner=x',headers:headers(f)})).statusCode,400)
 const result=await f.app.inject({method:'POST',url,headers:headers(f)})
 assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{state:'purged'})
 assert.equal(result.headers['cache-control'],'private, no-store')
})
test('purge object I/O shares bounded transfer admission',async t=>{
 let enter,release,count=0;const entered=new Promise(r=>{enter=r}),hold=new Promise(r=>{release=r})
 const f=await fileFixture(t,{wrapObjects:store=>({...store,removeUnreferenced:async key=>{if(++count===2)enter();await hold;await store.removeUnreferenced(key)}})})
 const users=[f.alice,f.bob,f.adminSigned],ids=[]
 for(const user of users){const id=(await importFile(f,user.token,await docxBytes())).file.fileId;ids.push(id);await f.files.trashFile(user.token,id)}
 const send=i=>f.app.inject({method:'POST',url:`/api/v1/files/${ids[i]}/purge`,headers:headers(f,users[i].token)}).then(result=>result)
 const a=send(0),b=send(1);await entered
 const c=send(2);let third
 try {third=await Promise.race([c,new Promise(r=>setTimeout(()=>r(null),500))])} finally {release()}
 await Promise.all([a,b,c]);assert.equal(third?.statusCode,503)
})

test('a draft rejected before PUT does not permanently block purging its file',async t=>{
 const f=await savedFixture(t),id=f.initial.fileId,lease=await f.leases.acquireLease(f.alice.token,id,{editorId:f.editorId})
 const draft=await f.revisions.stageUpload(f.alice.token,id,{size:10,baseRevision:f.saved.revision,leaseEpoch:lease.leaseEpoch,editorId:f.editorId})
 await assert.rejects(()=>f.files.receiveUpload(f.alice.token,draft.uploadId,Buffer.alloc(10)))
 await f.files.trashFile(f.alice.token,id)
 assert.equal((await f.files.purgeFile(f.alice.token,id)).state,'pending')
 assert.equal((await f.files.purgeFile(f.alice.token,id)).state,'purged')
})
test('retirement is monotonic and terminal upload references cannot be rebound to purged files',async t=>{
 const f=await savedFixture(t),id=f.initial.fileId
 await f.files.trashFile(f.alice.token,id);await f.files.purgeFile(f.alice.token,id)
 await assert.rejects(()=>owned(f,c=>c.query('UPDATE revision_outbox SET retired_at=NULL')),{code:'23514'})
 const draft=await f.files.stageUpload(f.alice.token,{name:'other.docx',size:f.bytes.length})
 await f.files.cancelUpload(f.alice.token,draft.uploadId)
 await assert.rejects(()=>owned(f,c=>c.query('UPDATE uploads SET file_id=$2 WHERE id=$1',[draft.uploadId,id])),{code:'23514'})
})

test('database lifecycle guards preserve cross-owner RLS instead of exposing retired file state',async t=>{
 const f=await fileFixture(t),bytes=await docxBytes(),file=(await importFile(f,f.alice.token,bytes)).file
 await f.files.trashFile(f.alice.token,file.fileId);await f.files.purgeFile(f.alice.token,file.fileId)
 const rev=randomUUID(),objectKey=`${f.deploymentId}/${f.alice.user.id}/objects/${rev}`
 await assert.rejects(()=>f.transactions.withPrincipalTransaction({kind:'session',token:f.bob.token},c=>c.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)',[rev,f.deploymentId,f.alice.user.id,file.fileId,objectKey,file.sha256,bytes.length])),{code:'42501'})
})

test('ordinary active-job metadata updates do not invert the file lock order',async t=>{
 const f=await jobFixture(t),job=await f.jobs.enqueueJob(f.alice.token,'docx.roundtrip',f.input,randomUUID()),held=await f.ownerPool.connect(),other=await f.ownerPool.connect()
 try {
  await held.query('BEGIN');await held.query('SELECT id FROM files WHERE id=$1 FOR UPDATE',[f.fileId])
  await other.query("SET statement_timeout='250ms'")
  assert.equal((await other.query("UPDATE native_jobs SET deadline_at=deadline_at+interval '1 second' WHERE id=$1",[job.id])).rowCount,1)
 } finally {await held.query('ROLLBACK');held.release();other.release()}
})
