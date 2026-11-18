import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
const entry={id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Shared model',model:'synthetic-model',baseUrl:'https://provider.example/v1',enabled:true}
const keyring={activeKeyId:'shared-test',keys:{'shared-test':new Uint8Array(32).fill(29)}}
async function fixture(t){
 const f=await restrictedFixture(t,{businessMax:2}),config=createGlobalConfigService({transactions:f.transactions,keyring})
 await config.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{...entry,apiKey:'synthetic-shared-key'}],defaults:{chat:entry.id}})
 const app=await buildLocalApp({db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,origin:'https://office.example',csrfKey:f.csrfKey,globalConfigKeyring:keyring,providerGateway:{mode:'shared'},codingHarnesses:false})
 f.cleanup.push(()=>app.close())
 const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:'https://office.example',key:f.csrfKey})
 const headers=who=>({cookie:'__Host-dyoffice-session='+who.token,origin:'https://office.example','x-csrf-token':csrf.sessionToken(who.token)})
 return {...f,config,app,headers}
}
test('all authorized users see the shared model; saves take effect without profiles, grants or restarting',async t=>{
 const f=await fixture(t)
 for(const user of [f.alice,f.bob]){
  const r=await f.app.inject({url:'/api/v1/ai/catalog',headers:f.headers(user)});assert.equal(r.statusCode,200);assert.deepEqual(r.json().entries,[{id:entry.id,label:entry.label,model:entry.model,providerId:entry.providerId}]);assert.equal(r.json().defaultId,entry.id);assert.ok(!r.body.includes('synthetic-shared-key'))
 }
 await f.config.saveGlobalConfig(f.adminSigned.token,1,{upserts:[{...entry,model:'updated-model'}]})
 assert.equal((await f.app.inject({url:'/api/v1/ai/catalog',headers:f.headers(f.alice)})).json().entries[0].model,'updated-model')
 await f.config.saveGlobalConfig(f.adminSigned.token,2,{upserts:[{...entry,enabled:false}]})
 assert.deepEqual((await f.app.inject({url:'/api/v1/ai/catalog',headers:f.headers(f.bob)})).json().entries,[])
 assert.ok([401,403].includes((await f.app.inject({url:'/api/v1/ai/catalog'})).statusCode))
})
test('shared provider uses scoped saved credentials once, streams, and rejects replay without funding user accounts',async t=>{
 const network=mockProviderNetwork(t,[Buffer.from('data: {"choices":[{"delta":{"content":"Hello shared"}}]}\n\ndata: [DONE]\n\n')]),f=await fixture(t)
 const request={method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{system:'',messages:[{role:'user',text:'Synthetic test'}],tools:[]}}}
 const r=await f.app.inject(request)
 assert.equal(r.statusCode,200);assert.match(r.body,/Hello shared/);assert.equal(network.writes,1);assert.equal(network.header,'Bearer synthetic-shared-key');assert.ok(!r.body.includes('synthetic-shared-key'))
 assert.equal((await f.ownerPool.query('SELECT * FROM provider_budget_accounts')).rowCount,0)
 assert.equal((await f.ownerPool.query('SELECT state FROM shared_provider_dispatches')).rows[0].state,'settled')
 const replay=await f.app.inject(request);assert.match(replay.body,/event: error/);assert.equal(network.writes,1)
 await f.sessions.logout(f.alice.token)
 assert.equal((await f.app.inject({...request,payload:{...request.payload,turnId:randomUUID()}})).statusCode,401)
})
test('private endpoint and missing CSRF cannot release the shared credential or dispatch',async t=>{
 const network=mockProviderNetwork(t,[]),f=await fixture(t)
 await f.config.saveGlobalConfig(f.adminSigned.token,1,{upserts:[{...entry,baseUrl:'https://127.0.0.1/v1'}]})
 const payload={turnId:randomUUID(),modelId:entry.id,request:{system:'',messages:[{role:'user',text:'Synthetic'}],tools:[]}}
 const denied=await f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:{cookie:f.headers(f.alice).cookie,origin:'https://office.example'},payload})
 assert.equal(denied.statusCode,403)
 const r=await f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload})
 assert.match(r.body,/event: error/);assert.equal(network.writes,0)
 assert.equal((await f.ownerPool.query('SELECT * FROM shared_provider_dispatches')).rowCount,0)
 await assert.rejects(f.businessPool.query('SELECT * FROM shared_provider_dispatches'),e=>e.code==='42501')
})
test('editing the shared model while TLS is pending blocks credentials from the old configuration',async t=>{
 let release;const gate=new Promise(r=>release=r),network=mockProviderNetwork(t,[],{secureGate:gate}),f=await fixture(t)
 const work=f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{system:'',messages:[{role:'user',text:'Synthetic'}],tools:[]}}})
 // Injection starts when consumed; wait for the transport to reach TLS.
 const result=Promise.resolve(work)
 await network.connected
 await f.config.saveGlobalConfig(f.adminSigned.token,1,{upserts:[{...entry,enabled:false}]})
 release();assert.match((await result).body,/event: error/);assert.equal(network.writes,0);assert.equal(network.header,undefined)
})

test('administrator can test a saved shared model; ordinary users cannot run the admin connection test',async t=>{
 const network=mockProviderNetwork(t,[Buffer.from('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')]),f=await fixture(t)
 const request={method:'POST',url:'/api/v1/admin/config/test-model',headers:f.headers(f.adminSigned),payload:{entryId:entry.id}}
 const denied=await f.app.inject({...request,headers:f.headers(f.alice)})
 assert.equal(denied.statusCode,403);assert.equal(network.writes,0)
 const result=await f.app.inject(request);assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{ok:true});assert.equal(network.writes,1);assert.ok(!result.body.includes('synthetic-shared-key'))
})
