import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../server/src/framework.ts'
import {registerJobRoutes} from '../server/src/modules/jobs/routes.ts'
import {SESSION_COOKIE} from '../server/src/modules/auth/csrf.ts'
import {getDocumentProfile} from '../worker/src/sandbox/document-profiles.ts'
import {createDocumentExecutionBoundary} from '../worker/src/sandbox/document-execution-boundary.ts'
import {createBrokerAdmissionBackend} from '../worker/src/sandbox/document-broker-admission.ts'
import {createTestPdfCommandQueue} from '../server/src/pdf/command-queue.ts'
import {createTestPdfClaimReader} from '../server/src/pdf/command-claim.ts'
import {createTestPdfLeaseController} from '../server/src/pdf/lease-controller.ts'
import {createTestPdfInputPreparation} from '../server/src/pdf/input-preparation.ts'
import {createTestPdfPreparedPackage} from '../server/src/pdf/prepared-package.ts'

const id='11111111-1111-4111-8111-111111111111'
const command={version:1,action:'rotatePages',operations:[{page:1,degrees:90}]}

// Real Fastify route/schema execution with trusted auth stubs; this tests the
// admission boundary, NOT PostgreSQL ownership, CSRF enforcement or job execution.
test('public jobs route refuses PDF rotations before queue admission, even for authenticated callers',async t=>{
 const app=await createApiShell(),calls=[]
 t.after(()=>app.close())
 registerJobRoutes(app,{async enqueueJob(...args){calls.push(args);throw Object.assign(Error('admitted'),{statusCode:418})},listJobs(){return {jobs:[]}}},
  {async authenticate(){}},{originCheck(){},requireSession(){}})
 const headers={cookie:`${SESSION_COOKIE}=${'a'.repeat(43)}`}
 for(const payload of [
  {type:'pdf.rotate',input:{artifactId:id},idempotencyKey:'rotation-contract'},
  {type:'pdf.rotate',input:{artifactId:id,command},idempotencyKey:'rotation-contract'},
  {type:'xlsx.roundtrip',input:{artifactId:id,command},idempotencyKey:'rotation-contract'},
  {type:'xlsx.roundtrip',input:{artifactId:id},idempotencyKey:'rotation-contract',command},
 ]){
  const response=await app.inject({method:'POST',url:'/api/v1/jobs',headers,payload})
  assert.equal(response.statusCode,400)
  assert.equal(calls.length,0,'no native queue admission for PDF or smuggled commands')
 }
 const allowed=await app.inject({method:'POST',url:'/api/v1/jobs',headers,payload:{type:'xlsx.roundtrip',input:{artifactId:id},idempotencyKey:'existing-roundtrip'}})
 assert.equal(allowed.statusCode,418,'existing XLSX route must still reach its service')
 assert.equal(calls.length,1)
})

test('PDF profile metadata and injected callbacks never enable the default production runtime',async()=>{
 const profile=getDocumentProfile('pdf-edit-v1')
 assert.equal(profile.productionEnabled,false)
 assert.equal(profile.network,'deny')
 let calls=0
 const injected={start(){calls++},execute(){calls++},stop(){calls++}}
 const input=new Uint8Array([37,80,68,70,45])
 await assert.rejects(createDocumentExecutionBoundary(injected).run({profileId:profile.id,command},input),{code:'DOCUMENT_BOUNDARY_UNAVAILABLE'})
 const backend=createBrokerAdmissionBackend(injected)
 for(const name of ['start','execute','stop'])await assert.rejects(backend[name]({},input,new AbortController().signal),{code:'DOCUMENT_BROKER_UNAVAILABLE'})
 assert.equal(calls,0)
})

for(const environment of ['production','development',undefined])test(`PDF candidate adapters deny ${environment??'unset'} NODE_ENV before touching storage`,()=>{
 const previous=process.env.NODE_ENV
 if(environment===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=environment
 let touched=0
 const transactions={withPrincipalTransaction(){touched++;throw Error('must not touch PG')}},pool={connect(){touched++;throw Error('must not touch PG')}},objects={read(){touched++;throw Error('must not touch objects')}}
 const options={transactions,workerPool:pool,issuerPool:pool,objects,deploymentId:id,schema:'public',expectedArtifactDigest:'a'.repeat(64),unsafeTestOnly:true}
 try{
  assert.throws(()=>createTestPdfCommandQueue(options))
  assert.throws(()=>createTestPdfClaimReader({pool,deploymentId:id,unsafeTestOnly:true}),{code:'PDF_CLAIM_DENIED'})
  assert.throws(()=>createTestPdfLeaseController(options),{code:'PDF_LEASE_DENIED'})
  assert.throws(()=>createTestPdfInputPreparation(options),{code:'PDF_INPUT_DENIED'})
  assert.throws(()=>createTestPdfPreparedPackage(options),{code:'PDF_PACKAGE_DENIED'})
  assert.equal(touched,0)
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous}
})

test('a test-created PDF queue cannot be reused after leaving the test environment',async()=>{
 const previous=process.env.NODE_ENV;let touched=0
 try{
  process.env.NODE_ENV='test'
  const queue=createTestPdfCommandQueue({transactions:{withPrincipalTransaction(){touched++;throw Error('must not touch PG')}},unsafeTestOnly:true})
  process.env.NODE_ENV='production'
  await assert.rejects(queue.enqueue('session',{artifactId:id,command},'rotation-contract'))
  await assert.rejects(queue.read('session',id))
  assert.equal(touched,0)
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous}
})
