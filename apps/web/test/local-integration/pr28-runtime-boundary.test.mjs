// Proposed new-stack regression: install under apps/web/test/local-integration/.
// Requires the actual restricted-role PostgreSQL fixture. No mock or skip.
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {restrictedOrigin} from '../helpers/restricted.mjs'
const headers=(f,token)=>({cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey}).sessionToken(token)})
test('fully configured local account runtime does not enable legacy shared object/source/conversation routes',async t=>{
 const f=await fileFixture(t,{nativeJobs:true})
 for(const token of [f.alice.token,f.bob.token,f.adminSigned.token]){
  for(const url of ['/api/v1/objects/'+randomUUID(),'/api/sources','/api/conversations','/api/admin/config']){
   const response=await f.app.inject({url,headers:headers(f,token)})
   assert.equal(response.statusCode,501,'legacy path must remain unimplemented in cookie runtime: '+url)
   assert.equal(response.json().status,501)
  }
 }
})
test('foreign and missing job identifiers disclose the same public error to user and config admin',async t=>{
 const f=await fileFixture(t,{nativeJobs:true})
 const file=await importFile(f,f.alice.token,await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url)),'scope.xlsx')
 const payload={type:'xlsx.roundtrip',input:{artifactId:file.file.revision},idempotencyKey:randomUUID()}
 const made=await f.app.inject({method:'POST',url:'/api/v1/jobs',headers:headers(f,f.alice.token),payload})
 assert.equal(made.statusCode,202);const id=made.json().id
 for(const token of [f.bob.token,f.adminSigned.token])for(const mutation of [false,true]){
  const get=async jobId=>f.app.inject({method:mutation?'POST':'GET',url:'/api/v1/jobs/'+jobId+(mutation?'/cancel':''),headers:headers(f,token)})
  const foreign=await get(id),missing=await get(randomUUID())
  assert.equal(foreign.statusCode,404);assert.equal(missing.statusCode,404)
  const publicBody=response=>{const {requestId,...rest}=response.json();assert.ok(requestId);return rest}
  assert.deepEqual(publicBody(foreign),publicBody(missing))
 }
})
test('revoked credential cannot enqueue or cancel an owned job after the authorization epoch changes',async t=>{
 const f=await fileFixture(t,{nativeJobs:true})
 const file=await importFile(f,f.alice.token,await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url)),'epoch.xlsx')
 const payload={type:'xlsx.roundtrip',input:{artifactId:file.file.revision},idempotencyKey:randomUUID()}
 const made=await f.app.inject({method:'POST',url:'/api/v1/jobs',headers:headers(f,f.alice.token),payload})
 assert.equal(made.statusCode,202)
 await f.users.update(f.adminSigned.token,f.alice.user.id,{roles:['personal','auditor']})
 for(const request of [
  {method:'POST',url:'/api/v1/jobs',payload:{...payload,idempotencyKey:randomUUID()}},
  {method:'POST',url:'/api/v1/jobs/'+made.json().id+'/cancel'},
 ])assert.equal((await f.app.inject({...request,headers:headers(f,f.alice.token)})).statusCode,401)
})
