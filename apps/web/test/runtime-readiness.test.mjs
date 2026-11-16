import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadinessProbe } from '../server/src/readiness.ts'
import { createApiShell } from '../server/src/framework.ts'
import { registerHealthRoutes } from '../server/src/modules/health/routes.ts'
test('configured dependencies fail closed and recover without inspecting personal data', async()=>{
 let business=true,storage=true; const queries=[]
 const ready=createReadinessProbe({identityReady:async()=>{},businessPool:{query:async sql=>{queries.push(sql);if(!business)throw Error('secret')}},objectStore:{checkReady:async()=>{if(!storage)throw Error('secret')}}})
 const app=await createApiShell();registerHealthRoutes(app,ready);await app.ready()
 try {
 assert.equal((await app.inject('/api/v1/health/ready')).statusCode,200)
 business=false;assert.equal((await app.inject('/api/v1/health/ready')).statusCode,503)
 business=true;storage=false;const failed=await app.inject('/api/v1/health/ready');assert.equal(failed.statusCode,503);assert.equal(failed.body.includes('secret'),false)
 assert.equal((await app.inject('/api/v1/health/live')).statusCode,200)
 storage=true;assert.equal((await app.inject('/api/v1/health/ready')).statusCode,200)
 assert.ok(queries.every(q=>q==='SELECT 1'))
 }finally{await app.close()}
})
test('unprobeable storage fails closed and hanging checks are bounded and coalesced',async()=>{
 assert.equal(await createReadinessProbe({identityReady:async()=>{},objectStore:{}})(),false)
 let calls=0,release;const gate=new Promise(r=>release=r)
 const ready=createReadinessProbe({identityReady:async()=>{calls++;await gate}},20)
 assert.deepEqual(await Promise.all([ready(),ready(),ready()]),[false,false,false]);assert.equal(calls,1)
 assert.equal(await ready(),false);assert.equal(calls,1)
 release();await new Promise(r=>setTimeout(r,0));assert.equal(await ready(),true);assert.equal(calls,2)
})
test('built-in storage probes detect directory and S3 failures without object writes',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path')
 const {createLocalObjectStore}=await import('../server/src/storage/local-dev.ts');const {createS3ObjectStore}=await import('../server/src/storage/s3.ts')
 const dir=await mkdtemp(join(tmpdir(),'ready-'));const local=await createLocalObjectStore({directory:dir})
 await local.checkReady();await rm(dir,{recursive:true});await assert.rejects(()=>local.checkReady())
 let reject=false;const commands=[];const s3=createS3ObjectStore({bucket:'private-test',client:{send:async(command,options)=>{commands.push(command.constructor.name);assert.ok(options.abortSignal);if(reject)throw Error('credential-secret')}}})
 await s3.checkReady();reject=true;await assert.rejects(()=>s3.checkReady(),error=>error.statusCode===503&&!error.message.includes('secret'))
 assert.deepEqual(commands,['HeadBucketCommand','HeadBucketCommand'])
})
