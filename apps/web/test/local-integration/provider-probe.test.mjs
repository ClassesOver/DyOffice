import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import dns from 'node:dns/promises'
import {restrictedFixture,restrictedOrigin} from '../helpers/restricted.mjs'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
const url='/api/v1/admin/ai/synthetic-probe'
async function appFor(f,enabled){return buildLocalApp({db:f.db,businessPool:f.businessPool, passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,adminAiSyntheticProbe:enabled})}
function headers(f,token){const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey});return {cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)}}
test('actual app defaults off; explicit synthetic probe is admin-only with no provider/config access',async t=>{
 t.mock.method(https,'request',()=>{throw Error('network forbidden')});t.mock.method(dns,'lookup',()=>{throw Error('DNS forbidden')})
 const f=await restrictedFixture(t)
 assert.equal((await f.app.inject({method:'POST',url,headers:headers(f,f.adminSigned.token),payload:{}})).statusCode,501)
 const app=await appFor(f,true);f.cleanup.push(()=>app.close())
 for(const token of [f.alice.token,f.bob.token]) assert.equal((await app.inject({method:'POST',url,headers:headers(f,token),payload:{}})).statusCode,403)
 const r=await app.inject({method:'POST',url,headers:headers(f,f.adminSigned.token),payload:{}})
 assert.equal(r.statusCode,200)
 assert.deepEqual(r.json(),{mode:'synthetic',result:'ok',externalRequests:0,credentialsRead:false,billable:false})
 assert.match(r.headers['cache-control'],/no-store/)
 assert.equal((await f.ownerPool.query('SELECT * FROM provider_budget_reservations')).rowCount,0)
 assert.equal((await f.ownerPool.query('SELECT * FROM global_config_secrets')).rowCount,0)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/turns',headers:headers(f,f.adminSigned.token),payload:{}})).statusCode,501)
 await f.authPool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.adminSigned.sessionId])
 assert.equal((await app.inject({method:'POST',url,headers:headers(f,f.adminSigned.token),payload:{}})).statusCode,403)
})
test('synthetic probe rejects token substitution, CSRF, cross-origin and user-supplied input',async t=>{
 const f=await restrictedFixture(t),app=await appFor(f,true);f.cleanup.push(()=>app.close())
 const h=headers(f,f.adminSigned.token)
 for(const bad of [{},{...h,origin:'https://evil.example'},{...h,'x-csrf-token':'bad'},{...h,authorization:'Bearer ignored'}])assert.ok((await app.inject({method:'POST',url,headers:bad,payload:{}})).statusCode>=400)
 for(const payload of [{model:'anything'},{apiKey:'synthetic'},{messages:[]},[]])assert.equal((await app.inject({method:'POST',url,headers:h,payload})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:url+'?provider=x',headers:h,payload:{}})).statusCode,400)
})
test('probe config requires literal boolean, restricted business pool and remains unavailable in production',async t=>{
 const f=await restrictedFixture(t)
 for(const value of ['true',1,null,{}])await assert.rejects(appFor(f,value),/synthetic probe/)
 await assert.rejects(buildLocalApp({db:f.db,passwords:f.passwords,deploymentId:f.deploymentId,origin:restrictedOrigin,csrfKey:f.csrfKey,adminAiSyntheticProbe:true}),/business pool/)
 const prior=process.env.NODE_ENV;process.env.NODE_ENV='production'
 try{await assert.rejects(appFor(f,true),/not allowed in production/)}finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior}
})
test('enabled app rejects a valid administrator session belonging to another deployment',async t=>{
 const a=await restrictedFixture(t),b=await restrictedFixture(t),app=await appFor(a,true);a.cleanup.push(()=>app.close())
 const r=await app.inject({method:'POST',url,headers:headers(a,b.adminSigned.token),payload:{}})
 assert.equal(r.statusCode,403)
 const off=await appFor(a,false);a.cleanup.push(()=>off.close())
 assert.equal((await off.inject({method:'POST',url,headers:headers(a,a.adminSigned.token),payload:{}})).statusCode,501)
})
