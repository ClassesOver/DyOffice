import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeExternalTokenRecord } from '../server/src/modules/auth/external-token-policy.ts'
const args = () => ({ deploymentId:'d1', audience:'dyoffice:mcp', now:1000,
 record:{deploymentId:'d1',ownerId:'u1',audience:'dyoffice:mcp',authVersion:2,expiresAt:2000,revokedAt:null,scopes:['files:read']},
 user:{deploymentId:'d1',id:'u1',status:'active',passwordResetRequired:false,authVersion:2,scopes:['files:read','files:write']} })
test('scopes attenuate; never invent browser session or roles',()=>{
 const a=args(); const result=authorizeExternalTokenRecord(a)
 assert.deepEqual(result,{kind:'external-token',deploymentId:'d1',userId:'u1',authVersion:2,scopes:['files:read']})
 assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.scopes))
 a.record.scopes.push('files:write'); assert.deepEqual(result.scopes,['files:read'])
})
test('reject revoked, expired, wrong audience, stale user and tenant/owner mismatch',()=>{
 for(const change of [a=>a.record.revokedAt=0,a=>a.record.expiresAt=1000,a=>a.audience='other',a=>a.user.authVersion=3,a=>a.user.status='disabled',a=>a.user.passwordResetRequired=true,a=>a.user.id='u2',a=>a.record.deploymentId='d2',a=>a.user.deploymentId='d2']){
  const a=args(); change(a); assert.throws(()=>authorizeExternalTokenRecord(a),/^Error: Access denied$/)
 }
})
test('malformed records and clocks fail closed; administrator grants no files',()=>{
 for(const change of [a=>a.now=NaN,a=>a.now=Infinity,a=>a.record.expiresAt=NaN,a=>a.record.authVersion=0,a=>a.record.scopes=['unknown'],a=>a.record.scopes=['files:read','files:read']]){
  const a=args();change(a);assert.throws(()=>authorizeExternalTokenRecord(a))
 }
 const a=args();a.user.scopes=['config:write'];assert.deepEqual(authorizeExternalTokenRecord(a).scopes,[])
})
test('recheck reflects expiry, revocation and removed write scope',()=>{
 const a=args();a.record.scopes=['files:read','files:write']
 assert.deepEqual(authorizeExternalTokenRecord(a).scopes,['files:read','files:write'])
 a.user.scopes=['files:read'];assert.deepEqual(authorizeExternalTokenRecord(a).scopes,['files:read'])
 a.now=2000;assert.throws(()=>authorizeExternalTokenRecord(a),/Access denied/)
 a.now=1000;a.record.revokedAt=1000;assert.throws(()=>authorizeExternalTokenRecord(a),/Access denied/)
})
