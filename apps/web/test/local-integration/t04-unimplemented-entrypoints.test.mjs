// Install under apps/web/test/local-integration/. Requires real restricted-role PG.
// This proves rejection only, not implementation or per-resource RLS for future APIs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileFixture } from '../helpers/files.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { restrictedOrigin } from '../helpers/restricted.mjs'
const operations = [
 ['POST','/api/v1/ai/turns'],
 ['POST','/api/v1/ai/turns/not-owned/cancel'],
 ['GET','/api/models'],
 ['GET','/api/sources'], ['PUT','/api/sources'],
 ['GET','/api/admin/config'], ['PUT','/api/admin/config'],
 ['POST','/api/admin/mcp/not-owned/test'],
 ['GET','/api/conversations'],
]
test('unimplemented AI/source/MCP entrances reject anonymous and development bearer credentials',async t=>{
 const f=await fileFixture(t,{nativeJobs:true})
 for(const authorization of [undefined,'Bearer personal-secret','Bearer admin-secret'])for(const [method,url] of operations){
  const response=await f.app.inject({method,url,headers:authorization?{authorization}:{}})
  assert.equal(response.statusCode,401,method+' '+url)
  assert.equal(response.json().status,401)
 }
})
test('authenticated user and config admin cannot activate legacy AI/source/MCP routes by role or forged owner',async t=>{
 const f=await fileFixture(t,{nativeJobs:true})
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
 for(const token of [f.alice.token,f.bob.token,f.adminSigned.token])for(const [method,url] of operations){
  const response=await f.app.inject({method,url,headers:{cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token),'x-owner-id':f.alice.user.id},...(method==='GET'?{}:{payload:{ownerId:f.alice.user.id,principal:{role:'config_admin'},url:'https://must-not-connect.invalid'}})})
  assert.equal(response.statusCode,501,method+' '+url)
  assert.equal(response.json().status,501)
  assert.doesNotMatch(response.headers['content-type']??'',/text\/event-stream/)
  assert.equal(response.body.includes('must-not-connect.invalid'),false)
 }
})
