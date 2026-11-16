import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { s3Fixture } from '../helpers/s3.mjs'
import { createFileService } from '../../server/src/modules/files/service.ts'
const credential=token=>({kind:'session',token})
async function gcFixture(t, options={}) {
 if(process.env.DYOFFICE_TEST_RECLAMATION_STORE === 's3') {
  const {store,bucket}=await s3Fixture(t)
  return {...await fileFixture(t,{...options,objectStore:store}),s3Bucket:bucket}
 }
 return fileFixture(t,options)
}
async function ready(f,token,bytes){
 const u=await f.files.stageUpload(token,{name:'orphan.docx',size:bytes.length})
 await f.files.receiveUpload(token,u.uploadId,bytes)
 return u
}
test('restricted PG: only owner terminal completed uploads are reclaimed, not committed/trash references',async t=>{
 const f=await gcFixture(t),bytes=await docxBytes(),token=f.alice.token
 const file=await importFile(f,token,bytes),u=await ready(f,token,bytes)
 await f.files.trashFile(token,file.file.fileId)
 await f.files.cancelUpload(token,u.uploadId)
 assert.equal((await f.files.usage(token)).storedBytes,bytes.length*2)
 assert.equal((await f.files.reclaimAbandonedUploads(f.bob.token)).reclaimedBytes,0)
 assert.equal((await f.files.reclaimAbandonedUploads(token)).reclaimedBytes,bytes.length)
 assert.equal((await f.files.reclaimAbandonedUploads(token)).reclaimedBytes,0)
 await f.files.restoreFile(token,file.file.fileId)
 assert.deepEqual(await f.files.readFile(token,file.file.fileId,file.file.revision),bytes)
 assert.equal((await f.files.usage(token)).storedBytes,bytes.length)
})
test('restricted PG: post-delete transaction rollback retains accounting; retry credits exactly once',async t=>{
 const f=await gcFixture(t),bytes=await docxBytes(),token=f.alice.token,u=await ready(f,token,bytes)
 await f.files.cancelUpload(token,u.uploadId)
 let fail=true
 const transactions={withPrincipalTransaction:(input,fn)=>f.transactions.withPrincipalTransaction(input,async(c,p)=>{const result=await fn(c,p);if(fail&&result?.reclaimedUploads)throw Error('forced post-delete rollback');return result})}
 const service=createFileService({transactions,objects:f.objects})
 await assert.rejects(()=>service.reclaimAbandonedUploads(token),/forced post-delete rollback/)
 assert.equal((await f.files.usage(token)).storedBytes,bytes.length)
 fail=false
 assert.equal((await service.reclaimAbandonedUploads(token)).reclaimedBytes,bytes.length)
 assert.equal((await service.reclaimAbandonedUploads(token)).reclaimedBytes,0)
 assert.equal((await f.files.usage(token)).storedBytes,0)
 await assert.rejects(()=>f.files.finishUpload(token,u.uploadId))
})
test('restricted PG: unfinished receiving upload is not reclaimed after expiry',async t=>{
 const f=await gcFixture(t),bytes=await docxBytes(),token=f.alice.token
 const u=await f.files.stageUpload(token,{name:'ambiguous.docx',size:bytes.length})
 await f.transactions.withPrincipalTransaction(credential(token),async(c,p)=>{
  await c.query("UPDATE uploads SET state='receiving',created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE deployment_id=$1 AND owner_id=$2 AND id=$3",[p.deploymentId,p.userId,u.uploadId])
 })
 assert.equal((await f.files.reclaimAbandonedUploads(token)).reclaimedBytes,0)
 assert.equal((await f.files.usage(token)).storedBytes,bytes.length)
})

test('restricted PG: concurrent collectors serialize and stale finish cannot resurrect deleted objects',async t=>{
 let entered, release
 const deleting=new Promise(resolve=>{entered=resolve}),hold=new Promise(resolve=>{release=resolve})
 let removed=0
 const f=await gcFixture(t,{wrapObjects:objects=>({...objects,removeUnreferenced:async key=>{removed++;entered();await hold;return objects.removeUnreferenced(key)}})})
 const {waitForDatabaseLock}=await import('../helpers/restricted.mjs')
 const bytes=await docxBytes(),token=f.alice.token,u=await ready(f,token,bytes)
 await f.files.cancelUpload(token,u.uploadId)
 const first=f.files.reclaimAbandonedUploads(token)
 await deleting
 const second=f.files.reclaimAbandonedUploads(token)
 const finish=f.files.finishUpload(token,u.uploadId).then(()=>({ok:true}),e=>({ok:false,status:e.statusCode}))
 try{await waitForDatabaseLock(f,'business')}finally{release()}
 const results=await Promise.all([first,second])
 assert.equal(results.reduce((n,r)=>n+r.reclaimedBytes,0),bytes.length)
 assert.equal(removed,1)
 assert.equal((await finish).ok,false)
 assert.equal((await f.files.usage(token)).storedBytes,0)
})

test('restricted PG: ready expiry commits before deletion and cannot revive after rollback',async t=>{
 const f=await gcFixture(t),bytes=await docxBytes(),token=f.alice.token,u=await ready(f,token,bytes)
 await f.transactions.withPrincipalTransaction(credential(token),async(c,p)=>{
  await c.query("UPDATE uploads SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE deployment_id=$1 AND owner_id=$2 AND id=$3",[p.deploymentId,p.userId,u.uploadId])
 })
 let fail=true
 const transactions={withPrincipalTransaction:(input,fn)=>f.transactions.withPrincipalTransaction(input,async(c,p)=>{const result=await fn(c,p);if(fail&&result?.reclaimedUploads)throw Error('post-delete rollback');return result})}
 const service=createFileService({transactions,objects:f.objects})
 await assert.rejects(()=>service.reclaimAbandonedUploads(token),/post-delete rollback/)
 const row=await f.transactions.withPrincipalTransaction(credential(token),async(c,p)=>(await c.query('SELECT state,reclaimed_at FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND id=$3',[p.deploymentId,p.userId,u.uploadId])).rows[0])
 assert.equal(row.state,'expired');assert.equal(row.reclaimed_at,null)
 fail=false;assert.equal((await service.reclaimAbandonedUploads(token)).reclaimedBytes,bytes.length)
 await assert.rejects(()=>f.files.finishUpload(token,u.uploadId),{statusCode:410})
 assert.equal((await f.files.usage(token)).storedBytes,0)
})

test('restricted PG: process exit after physical deletion rolls metadata back and retry is safe',async t=>{
 const f=await gcFixture(t),bytes=await docxBytes(),token=f.alice.token,u=await ready(f,token,bytes)
 await f.files.cancelUpload(token,u.uploadId)
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
 const transactions={withPrincipalTransaction:(input,fn)=>base.withPrincipalTransaction(input,async(c,p)=>{const result=await fn(c,p);if(result?.reclaimedUploads)process.exit(77);return result})};
 await createFileService({transactions,objects}).reclaimAbandonedUploads(process.env.GC_TEST_TOKEN);
 await pool.end();process.exit(0);
 `
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{cwd:new URL('../../../..',import.meta.url),env:{...process.env,GC_TEST_DB:f.urls.business,GC_TEST_DEPLOYMENT:f.deploymentId,GC_TEST_TOKEN:token,GC_TEST_DIRECTORY:f.directory,...(f.s3Bucket?{GC_TEST_BUCKET:f.s3Bucket}:{})},stdio:['ignore','ignore','pipe']})
 let errors='';child.stderr.on('data',data=>{errors+=data})
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 assert.equal(exit,77,errors)
 assert.equal((await f.files.usage(token)).storedBytes,bytes.length)
 assert.equal((await f.files.reclaimAbandonedUploads(token)).reclaimedBytes,bytes.length)
 assert.equal((await f.files.usage(token)).storedBytes,0)
})
