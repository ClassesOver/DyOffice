import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
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
test('a shared Office turn preserves its tool call when the provider finishes and closes without DONE',async t=>{
 const frame=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n')
 const network=mockProviderNetwork(t,[frame({choices:[{delta:{tool_calls:[{index:0,id:'read',function:{name:'read_pages',arguments:'{"start":1}'}}]},finish_reason:'tool_calls'}]}),frame({choices:[],usage:{prompt_tokens:3,completion_tokens:4}})]),f=await fixture(t)
 const r=await f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{format:'pdf',system:'',messages:[{role:'user',text:'Read the PDF'}],tools:[{name:'read_pages',description:'Read pages',inputSchema:{type:'object'}}]}}})
 assert.equal(r.statusCode,200)
 assert.match(r.body,/event: tool_call\ndata: {"id":"read","name":"read_pages","input":{"start":1}}/)
 assert.match(r.body,/event: usage\ndata: {"inputTokens":3,"outputTokens":4}/)
 assert.match(r.body,/event: done/)
 assert.doesNotMatch(r.body,/event: error/)
 assert.equal(network.writes,1)
 assert.equal((await f.ownerPool.query('SELECT state FROM shared_provider_dispatches')).rows[0].state,'settled')
})
test('the shared gateway gives standalone PPTX page generation room to return a complete spec',{timeout:15000},async t=>{
 const spec='{"background":"#FFFFFF","elements":[{"type":"text","x":32,"y":32,"w":680,"h":96}]}'
 const network=mockProviderNetwork(t,()=>{
  const truncated=JSON.parse(network.wire).max_tokens<16384
  return Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:truncated?spec.slice(0,-1):spec},finish_reason:truncated?'length':'stop'}]})+'\n\ndata: [DONE]\n\n')])
 }),f=await fixture(t)
 const turn=(format,tools=[])=>f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{format,system:'',messages:[{role:'user',text:'Design the requested page'}],tools}}})
 const response=await turn('pptx')
 assert.doesNotMatch(response.body,/event: (stop_reason|error)/)
 assert.ok(response.body.includes('event: delta\ndata: '+JSON.stringify({text:spec})))
 assert.equal(JSON.parse(network.wire).reasoning_effort,undefined)
 await f.config.saveGlobalConfig(f.adminSigned.token,1,{upserts:[{...entry,model:'deepseek-v4-flash-0731'}]})
 await turn('pptx')
 assert.equal(JSON.parse(network.wire).reasoning_effort,'none')
 await turn('pptx',[{name:'generate_deck',description:'Generate editable slides',inputSchema:{type:'object'}}])
 assert.equal(JSON.parse(network.wire).max_tokens,4096)
 assert.equal(JSON.parse(network.wire).reasoning_effort,undefined)
 await turn('docx')
 assert.equal(JSON.parse(network.wire).max_tokens,4096)
 assert.equal(JSON.parse(network.wire).reasoning_effort,undefined)
})
test('standalone PPTX page generation can finish beyond two minutes at the gateway',{timeout:15000},async t=>{
 let started,release
 const ready=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
 const frame=value=>Buffer.from('data: '+JSON.stringify(value)+'\n\n')
 const network=mockProviderNetwork(t,()=>Readable.from((async function*(){
  yield frame({choices:[{delta:{reasoning_content:'Planning the slide'}}]})
  started()
  await gate
  yield frame({choices:[{delta:{content:'page JSON'},finish_reason:'stop'}]})
  yield Buffer.from('data: [DONE]\n\n')
 })()))
 const f=await fixture(t)
 t.mock.timers.enable({apis:['setTimeout']})
 try{
  const response=f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{format:'pptx',system:'',messages:[{role:'user',text:'Design one editable slide'}],tools:[]}}})
  await ready
  t.mock.timers.tick(121000)
  release()
  assert.match((await response).body,/event: delta\ndata: \{"text":"page JSON"\}/)
  assert.equal(network.writes,1)
 }finally{release();t.mock.timers.reset()}
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

for(const [format,status,message,reason] of [
 ['docx',401,'The model provider rejected authentication. Ask your administrator to check the model settings.','PROVIDER_AUTH_REJECTED'],
 ['xlsx',403,'The model provider rejected authentication. Ask your administrator to check the model settings.','PROVIDER_AUTH_REJECTED'],
 ['pptx',429,'The model provider is rate limited or out of quota. Try again later or choose another model.','PROVIDER_RATE_LIMITED'],
 ['pdf',503,'The model provider is temporarily unavailable. Try again later or choose another model.','PROVIDER_TEMPORARILY_UNAVAILABLE'],
 ['pdf',302,'AI stream unavailable',undefined],
])test(`shared Office gateway returns safe guidance for provider HTTP ${status}`,async t=>{
 const network=mockProviderNetwork(t,[Buffer.from('private body: synthetic-provider-credential')],{status}),f=await fixture(t)
 const response=await f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{format,system:'',messages:[{role:'user',text:'Synthetic'}],tools:[]}}})
 assert.equal(response.statusCode,200)
 assert.equal(response.body,`event: error\ndata: ${JSON.stringify({message,...(reason?{reason}:{})})}\n\nevent: done\ndata: {}\n\n`)
 assert.equal(network.writes,1)
 const probe=await f.app.inject({method:'POST',url:'/api/v1/admin/config/test-model',headers:f.headers(f.adminSigned),payload:{entryId:entry.id}})
 assert.equal(probe.statusCode,200)
 assert.deepEqual(probe.json(),reason?{ok:false,reason}:{ok:false})
 assert.equal(network.writes,2)
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
