import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createLocalObjectStore } from '../server/src/storage/local-dev.ts'
import { createS3ObjectStore } from '../server/src/storage/s3.ts'
const key='00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/objects/00000000-0000-4000-8000-000000000003'
test('local removal is idempotent, namespace bounded and durable across reopening', async t => {
 const directory=await mkdtemp(join(process.cwd(),'.gc-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const s=await createLocalObjectStore({directory}), ref=await s.putImmutable(key,Buffer.from('hello'))
 assert.equal(typeof s.removeUnreferenced,'function')
 await assert.rejects(()=>s.removeUnreferenced('../outside'),{statusCode:400})
 await s.removeUnreferenced(key); await s.removeUnreferenced(key)
 const reopened=await createLocalObjectStore({directory})
 await assert.rejects(()=>reopened.readVerified(ref),{statusCode:503})
})
test('S3 removal refuses versioned/suspended/unknown bucket state; missing object is idempotent',async()=>{
 for(const Status of ['Enabled','Suspended','invalid']){
  const calls=[], s=createS3ObjectStore({bucket:'test-store',client:{send:async cmd=>{calls.push(cmd.constructor.name);return {Status}}}})
  assert.equal(typeof s.removeUnreferenced,'function')
  await assert.rejects(()=>s.removeUnreferenced(key),{statusCode:503})
  assert.deepEqual(calls,['GetBucketVersioningCommand'])
 }
 const calls=[],s=createS3ObjectStore({bucket:'test-store',client:{send:async cmd=>{calls.push(cmd.constructor.name);return {}}}})
 await s.removeUnreferenced(key);await s.removeUnreferenced(key)
 assert.deepEqual(calls,['GetBucketVersioningCommand','DeleteObjectCommand','GetBucketVersioningCommand','DeleteObjectCommand'])
})

import { createFileService } from '../server/src/modules/files/service.ts'
const p={deploymentId:key.split('/')[0],userId:key.split('/')[1],scopes:['files:write','files:read'],sessionId:'s',authVersion:1}
const id='00000000-0000-4000-8000-000000000004', revision=key.split('/')[3]
function model({failCommit=false,failDelete=false,referenced=false,job=false}={}){
 const state={stored:5,reclaimed:false,deleted:false,deleteCalls:0,queries:[],failCommit}
 const connection={query:async(sql,args)=>{
  state.queries.push(sql)
  if(sql.startsWith('INSERT INTO uploads')){assert.deepEqual(args.slice(1,3),[p.deploymentId,p.userId]);return {rows:[{expires_at:new Date(Date.now()+60000)}],rowCount:1}}
  assert.deepEqual(args?.slice(0,2),[p.deploymentId,p.userId])
  if(sql.startsWith('SELECT id FROM workspaces'))return {rows:[{id:'w'}]}
  if(sql.startsWith('INSERT INTO storage_accounts')||sql.startsWith('SELECT 1 FROM storage_accounts'))return {rows:[],rowCount:1}
  if(sql.startsWith('WITH candidates'))return {rows:[],rowCount:0}
  if(sql.startsWith('SELECT * FROM storage_accounts')||sql.startsWith('SELECT stored_bytes FROM storage_accounts'))return {rows:[{stored_bytes:state.stored,reserved_bytes:0}]}
  if(sql.includes('FROM uploads u')&&sql.includes('FOR UPDATE')){
   assert.match(sql,/state IN \('cancelled','expired'\)/);assert.match(sql,/sha256 IS NOT NULL/);assert.match(sql,/reclaimed_at IS NULL/);assert.match(sql,/NOT EXISTS/);assert.match(sql,/LIMIT 1 FOR UPDATE/)
   return {rows:state.reclaimed||referenced?[]:[{id,revision_id:revision,expected_size:5,sha256:'a'.repeat(64),state:'cancelled'}]}
  }
  if(sql.startsWith('SELECT 1 FROM uploads'))return {rows:[],rowCount:0}
  if(sql.startsWith('UPDATE storage_accounts SET reserved_bytes'))return {rows:[],rowCount:1}
  if(sql.startsWith('UPDATE uploads')){state.reclaimed=true;return {rowCount:1,rows:[]}}
  if(sql.startsWith('UPDATE storage_accounts')){assert.equal(state.deleted,true);state.stored-=args[2];return {rowCount:1,rows:[]}}
  throw Error('Unexpected SQL '+sql)
 }}
 const transactions={withPrincipalTransaction:async(_credential,fn)=>{
  const before={stored:state.stored,reclaimed:state.reclaimed}
  try{const result=await fn(connection,job?{...p,job:{id:'job'}}:p);if(state.failCommit&&state.deleted)throw Error('lost commit');return result}
  catch(e){Object.assign(state,before);throw e}
 }}
 const objects={removeUnreferenced:async(k)=>{assert.equal(k,key);state.deleteCalls++;if(failDelete)throw Error('offline');state.deleted=true}}
 const service=createFileService({transactions,objects})
 return {state,service}
}
test('terminal unreferenced upload credits quota only after deletion, once',async()=>{
 const {state,service}=model();assert.equal(typeof service.reclaimAbandonedUploads,'function')
 assert.deepEqual(await service.reclaimAbandonedUploads('token'),{reclaimedBytes:5,reclaimedUploads:1})
 assert.equal(state.stored,0)
 assert.deepEqual(await service.reclaimAbandonedUploads('token'),{reclaimedBytes:0,reclaimedUploads:0})
 assert.equal(state.deleteCalls,1)
})
test('object deletion then failed commit retries idempotently without a second quota credit',async()=>{
 const {state,service}=model({failCommit:true});assert.equal(typeof service.reclaimAbandonedUploads,'function')
 await assert.rejects(()=>service.reclaimAbandonedUploads('token'),/lost commit/)
 assert.equal(state.deleted,true);assert.equal(state.stored,5);assert.equal(state.reclaimed,false)
 state.failCommit=false;await service.reclaimAbandonedUploads('token');assert.equal(state.stored,0)
 await service.reclaimAbandonedUploads('token');assert.equal(state.stored,0);assert.equal(state.deleteCalls,2)
})
test('referenced objects and job principals never reach object deletion; failure retains accounting',async()=>{
 for(const option of [{referenced:true},{job:true},{failDelete:true}]){
  const {state,service}=model(option);assert.equal(typeof service.reclaimAbandonedUploads,'function')
  if(option.referenced||option.failDelete)await service.reclaimAbandonedUploads('token');else await assert.rejects(()=>service.reclaimAbandonedUploads('token'))
  assert.equal(state.stored,5);assert.equal(state.reclaimed,false)
  if(!option.failDelete)assert.equal(state.deleteCalls,0)
 }
})

test('unavailable physical reclamation retains charge but does not block uploads with free quota',async()=>{
 const {state,service}=model({failDelete:true})
 const result=await service.stageUpload('token',{name:'safe.docx',size:5})
 assert.ok(result.uploadId);assert.equal(state.stored,5);assert.equal(state.reclaimed,false)
})

test('S3 reclamation shares one five-second deadline across version check and delete',async t=>{
 const signals=[], deadlines=[]
 const original=AbortSignal.timeout
 t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return original(ms)})
 const store=createS3ObjectStore({bucket:'test-store',client:{send:async(_cmd,options)=>{signals.push(options.abortSignal);return {}}}})
 await store.removeUnreferenced(key)
 assert.deepEqual(deadlines,[5000]);assert.equal(signals[0],signals[1])
})
