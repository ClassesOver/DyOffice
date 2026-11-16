import test from 'node:test'
import assert from 'node:assert/strict'
import {createSecretBox} from '../../server/src/modules/admin/secrets.ts'
import {createScopedAdminCredentialConsumer} from '../../server/src/modules/providers/credential-consumer.ts'
const keyring={activeKeyId:'k1',keys:{k1:new Uint8Array(32).fill(7)}}
const principal={deploymentId:'dep',userId:'admin',sessionId:'session',roles:['config_admin']}
const profile={deploymentId:'dep',entryId:'primary',revision:1,providerId:'openai',model:'model',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions'}
const request={reservationId:'reservation',claimId:'claim',entryId:'primary',configRevision:1,requestDigest:'a'.repeat(64),turnId:'turn'}
function setup(consume,overrides={}){
 const envelope=createSecretBox(keyring).seal('unit-secret',{deploymentId:'dep',configId:'primary',providerId:'openai',kind:'chat'})
 const row={revision:1,id:'primary',kind:'chat',provider_id:'openai',model:'model',base_url:profile.baseUrl,enabled:true,envelope}
 const calls=[]
 const connection={query:async sql=>{calls.push(sql);return {rows:sql.includes('SELECT c.revision')?[row]:sql.includes('AS authorized')?[{authorized:true}]:[]}}}
 let taken=false
 const deps={keyring,profiles:[profile],transactions:{sessionIdleMs:1000,withPrincipalTransaction:async(_,fn)=>fn(connection,principal)},
 takeForDispatch:async()=>{if(taken)throw Error('duplicate');taken=true;return {...request,...principal,id:request.reservationId}},consume,...overrides}
 return {service:createScopedAdminCredentialConsumer(deps),row,calls}
}
test('real T12 envelope decrypted only for scoped callback and buffer cleared after settlement',async()=>{
 let captured,scope
 const {service}=setup(async s=>{captured=s.credential;scope=s;assert.equal(captured.toString(),'unit-secret');return 'unit-secret'})
 assert.equal(await service.run('token',request),undefined)
 assert.ok(captured.every(b=>b===0));assert.equal(scope.endpoint,profile.endpoint);assert.ok(Object.isFrozen(scope))
 await assert.rejects(service.run('token',request),{message:'Provider credential unavailable'})
})
test('callback secret error and return cannot escape',async()=>{
 let captured;const {service}=setup(async s=>{captured=s.credential;throw new Error('unit-secret')})
 await assert.rejects(service.run('token',request),{message:'Provider credential unavailable'})
 assert.ok(captured.every(b=>b===0))
})
test('rejects config changes before decrypt',async()=>{
 let called=false;const f=setup(async()=>{called=true});f.row.model='other'
 await assert.rejects(f.service.run('token',request));assert.equal(called,false)
})
test('rejects ordinary member even if claim dependency returns a grant',async()=>{
 let called=false;const f=setup(async()=>{called=true},{transactions:{sessionIdleMs:1000,withPrincipalTransaction:async(_,fn)=>fn({query:async()=>({rows:[]})},{...principal,roles:['personal']})}})
 await assert.rejects(f.service.run('token',request));assert.equal(called,false)
})
test('abort before dispatch does not consume claim',async()=>{
 let called=false;const f=setup(async()=>{}, {takeForDispatch:async()=>{called=true;throw Error()}})
 const c=new AbortController();c.abort(new Error('private'))
 await assert.rejects(f.service.run('token',{...request,signal:c.signal}),{message:'Provider credential unavailable'});assert.equal(called,false)
})
test('constructor snapshot and dispose prevent key mutation or further usage',async()=>{
 const local={activeKeyId:'k1',keys:{k1:new Uint8Array(32).fill(7)}}
 const f=setup(async s=>assert.equal(s.credential.toString(),'unit-secret'),{keyring:local});local.keys.k1.fill(0)
 await f.service.run('token',request);f.service.dispose();await assert.rejects(f.service.run('token',request))
})
for(const change of [r=>r.enabled=false,r=>r.kind='image_generation',r=>r.provider_id='other',r=>r.base_url='https://other.example/',r=>r.revision=2,r=>r.envelope.ciphertext='invalid'])test('rejects changed authority '+change,async()=>{
 let called=false;const f=setup(async()=>{called=true});change(f.row);await assert.rejects(f.service.run('token',request));assert.equal(called,false)
})
test('rejects extra profile fields and redacts malformed endpoint at construction',()=>{
 assert.throws(()=>setup(async()=>{}, {profiles:[{...profile,apiKey:'private'}]}),{message:'Provider credential unavailable'})
 assert.throws(()=>setup(async()=>{}, {profiles:[{...profile,endpoint:'private-secret'}]}),{message:'Provider credential unavailable'})
})
for(const field of ['deploymentId','userId','sessionId','entryId','configRevision','requestDigest','turnId'])test('rejects mismatched dispatch grant '+field,async()=>{
 let called=false
 const f=setup(async()=>{called=true},{takeForDispatch:async()=>({...request,...principal,[field]:field==='configRevision'?2:'other'})})
 await assert.rejects(f.service.run('token',request),{message:'Provider credential unavailable'});assert.equal(called,false)
})
test('forwards immutable request digest/turn binding to the trusted consumer',async()=>{
 const f=setup(async scope=>{assert.equal(scope.requestDigest,request.requestDigest);assert.equal(scope.turnId,request.turnId)})
 await f.service.run('token',request)
})
test('SQL authorization false after config lock denies even with admin principal snapshot',async()=>{
 let called=false
 const f=setup(async()=>{called=true},{transactions:{sessionIdleMs:1000,withPrincipalTransaction:async(_,fn)=>fn({query:async()=>({rows:[{authorized:false}]})},principal)}})
 await assert.rejects(f.service.run('token',request));assert.equal(called,false)
})
