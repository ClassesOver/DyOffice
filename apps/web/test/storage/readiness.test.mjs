import test from 'node:test'
import assert from 'node:assert/strict'
import { S3Client, DeleteBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3'
import { s3Fixture } from '../helpers/s3.mjs'
import { createS3ObjectStore } from '../../server/src/storage/s3.ts'
import { createReadinessProbe } from '../../server/src/readiness.ts'
import { createApiShell } from '../../server/src/framework.ts'
import { registerHealthRoutes } from '../../server/src/modules/health/routes.ts'

test('real S3 readiness reports missing bucket and recovers while liveness stays healthy', async t => {
 const f=await s3Fixture(t)
 const app=await createApiShell();registerHealthRoutes(app,createReadinessProbe({identityReady:async()=>{},objectStore:f.store}));await app.ready();t.after(()=>app.close())
 const ready=()=>app.inject('/api/v1/health/ready')
 assert.equal((await ready()).statusCode,200)
 await f.client.send(new DeleteBucketCommand({Bucket:f.bucket}))
 try {
 const response=await ready();assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{state:'unavailable'})
 assert.equal((await app.inject('/api/v1/health/live')).statusCode,200)
 }finally {await f.client.send(new CreateBucketCommand({Bucket:f.bucket}))}
 assert.equal((await ready()).statusCode,200)
})
test('real S3 rejects invalid signing credentials without leaking secret or endpoint',async t=>{
 const f=await s3Fixture(t)
 const secret='invalid-readiness-test-secret'
 const client=new S3Client({endpoint:process.env.DYOFFICE_TEST_S3_ENDPOINT,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.DYOFFICE_TEST_S3_ACCESS_KEY,secretAccessKey:secret},maxAttempts:1});t.after(()=>client.destroy())
 const store=createS3ObjectStore({client,bucket:f.bucket})
 const app=await createApiShell();registerHealthRoutes(app,createReadinessProbe({identityReady:async()=>{},objectStore:store}));await app.ready();t.after(()=>app.close())
 const response=await app.inject('/api/v1/health/ready');assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{state:'unavailable'});assert.equal(response.body.includes(secret),false)
 assert.equal((await app.inject('/api/v1/health/live')).statusCode,200)
})
