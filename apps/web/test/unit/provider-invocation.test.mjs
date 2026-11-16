import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareProviderInvocation } from '../../server/src/modules/providers/invocation.ts'
const identity = {deploymentId:'dep',userId:'usr',sessionId:'ses'}
function fixture() {
 const binding={...identity,turnId:'turn',modelId:'model',configId:'config',revision:'rev'}
 return {identity,turnId:'turn',modelId:'model',now:100,
 grant:{...binding,enabled:true,expiresAt:200,credential:{deploymentId:'dep',ownerId:'usr',ref:'secret-ref'},egressProfileId:'approved'},
 reservation:{...binding,id:'reservation',state:'reserved',expiresAt:200,maxInputTokens:1000,maxOutputTokens:500},
 profiles:[{id:'approved',deploymentId:'dep',revision:'rev',protocol:'openai-chat',endpoint:'https://api.example.com/v1/chat/completions'}]}
}
test('projects a detached immutable plan without secret or caller transport options',()=>{
 const f=fixture();const p=prepareProviderInvocation(f)
 assert.equal(p.endpoint,'https://api.example.com/v1/chat/completions')
 assert.equal(p.reservationId,'reservation');assert.equal(p.credentialRef,'secret-ref')
 f.grant.credential.ref='changed';assert.equal(p.credentialRef,'secret-ref')
 assert.ok(Object.isFrozen(p));assert.equal(p.apiKey,undefined)
})
for(const field of ['deploymentId','userId','sessionId','turnId','modelId','configId','revision']) {
 test('rejects reservation mismatched '+field,()=>{const f=fixture();f.reservation[field]='other';assert.throws(()=>prepareProviderInvocation(f),/Provider invocation unavailable/)})
}
for(const mutate of [
 f=>f.grant.deploymentId='other',f=>f.grant.userId='other',f=>f.grant.sessionId='other',
 f=>f.grant.turnId='other',f=>f.grant.modelId='other',f=>f.grant.enabled=false,
 f=>f.grant.credential.ownerId='other',f=>f.grant.credential.deploymentId='other',
 f=>f.grant.expiresAt=100,f=>f.reservation.expiresAt=100,f=>f.reservation.state='unknown',
 f=>f.reservation.maxOutputTokens=0,f=>f.reservation.maxInputTokens=Infinity,
 f=>f.profiles=[],f=>f.profiles.push({...f.profiles[0]}),f=>f.profiles[0].deploymentId='other',
 f=>f.profiles[0].revision='other',f=>f.profiles[0].endpoint='http://api.example.com/',
 f=>f.profiles[0].endpoint='https://key:secret@api.example.com/',f=>f.profiles[0].endpoint='https://api.example.com/?key=secret',
 f=>f.profiles[0].endpoint='https://api.example.com/#secret',f=>f.grant.baseURL='https://evil.example/',
 f=>f.grant.credential.apiKey='secret',f=>f.now=NaN
]) test('fails closed for invalid authority '+mutate.toString(),()=>{const f=fixture();mutate(f);assert.throws(()=>prepareProviderInvocation(f),{message:'Provider invocation unavailable'})})
test('rejects untrusted malformed shapes with redacted error',()=>{
 for(const v of [undefined,null,{}, {grant:{apiKey:'private-key'}}])assert.throws(()=>prepareProviderInvocation(v),{message:'Provider invocation unavailable'})
})
