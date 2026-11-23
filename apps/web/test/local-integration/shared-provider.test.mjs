import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {mockProviderNetwork} from '../helpers/provider-network.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'
import {AgentLoop} from '../../../../packages/agent-core/src/loop.ts'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
const entry={id:'shared-chat',kind:'chat',providerId:'deepseek',label:'Shared model',model:'synthetic-model',baseUrl:'https://provider.example/v1/chat/completions',enabled:true}
const keyring={activeKeyId:'shared-test',keys:{'shared-test':new Uint8Array(32).fill(29)}}
async function fixture(t,modelEntry=entry){
 const f=await restrictedFixture(t,{businessMax:2}),config=createGlobalConfigService({transactions:f.transactions,keyring})
 await config.saveGlobalConfig(f.adminSigned.token,0,{upserts:[{...modelEntry,apiKey:'synthetic-shared-key'}],defaults:{chat:modelEntry.id}})
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
 assert.equal(JSON.parse(network.wire).max_tokens,32768)
 assert.equal(JSON.parse(network.wire).reasoning_effort,undefined)
 await turn('docx')
 assert.equal(JSON.parse(network.wire).max_tokens,32768)
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
for(const format of ['docx','xlsx','pptx','pdf'])test(`shared ${format} tool turns can complete near the 1800-second deadline`,{timeout:15000},async t=>{
 let started,release
 const ready=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
 const network=mockProviderNetwork(t,()=>Readable.from((async function*(){
  yield Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"Working"}}]}\n\n')
  started();await gate
  yield Buffer.from('data: {"choices":[{"delta":{"content":"Completed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
 })()))
 const f=await fixture(t)
 t.mock.timers.enable({apis:['setTimeout']})
 try{
  const response=f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{format,system:'',messages:[{role:'user',text:'Complete the document task'}],tools:[{name:'create_document',description:'Create document',inputSchema:{type:'object'}}]}}})
  await ready
  t.mock.timers.tick(1799000)
  release()
  const result=await response
  assert.match(result.body,/event: delta\ndata: {"text":"Completed"}/)
  assert.doesNotMatch(result.body,/event: error/)
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
test('DeepSeek defaults to Responses, lowers a rejected cap once, remembers it and replays tool reasoning without repeating a call',async t=>{
 const sent=[]
 const network=mockProviderNetwork(t,()=>{
  const body=JSON.parse(network.wire)
  sent.push(body)
  if(sent.length===1)return Readable.from([Buffer.from('max_output_tokens supports at most 8192')])
  const output=sent.length===2?[{type:'reasoning',id:'rs_1',encrypted_content:'sealed'},{type:'function_call',call_id:'c1',name:'read_pages',arguments:'{"start":1}'}]:[]
  const frame=value=>'data: '+JSON.stringify(value)+'\n\n'
  const incomplete=sent.length===4
  if(incomplete)output.push({type:'function_call',call_id:'partial',name:'read_pages',arguments:'{'})
  return Readable.from([Buffer.from((sent.length>2?frame({type:'response.output_text.delta',delta:'answer'}):'')+frame({type:incomplete?'response.incomplete':'response.completed',response:{status:incomplete?'incomplete':'completed',output,...(incomplete?{incomplete_details:{reason:'max_output_tokens'}}:{})}}))])
 },{status:n=>n===1?422:200}),f=await fixture(t)
 await f.config.saveGlobalConfig(f.adminSigned.token,1,{upserts:[{...entry,baseUrl:'https://provider.example/v1',model:'deepseek-v4-flash'}]})
 const tool={name:'read_pages',description:'Read pages',inputSchema:{type:'object'}}
 const user={role:'user',text:'Read page one'}
 const turn=messages=>f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{turnId:randomUUID(),modelId:entry.id,request:{format:'pdf',system:'Office',messages,tools:[tool]}}})
 const first=await turn([user])
 assert.match(first.body,/event: tool_call/)
 const call=JSON.parse(/event: tool_call\ndata: (.+)/.exec(first.body)[1])
 const second=await turn([user,{role:'assistant',text:'',toolCalls:[call]},{role:'tool',results:[{id:call.id,name:tool.name,output:'Page one'}]}])
 assert.match(second.body,/event: delta\ndata: {"text":"answer"}/)
 assert.deepEqual(sent.map(b=>b.max_output_tokens),[32768,8192,8192])
 assert.equal(sent[2].store,false)
 assert.deepEqual(sent[2].input.slice(1).map(i=>i.type),['reasoning','function_call','function_call_output'])
 const cut=await turn([user])
 assert.match(cut.body,/event: stop_reason\ndata: {"reason":"max_tokens"}/)
 assert.doesNotMatch(cut.body,/event: (error|tool_call)/)
 assert.equal(network.writes,4)
 assert.equal((await f.ownerPool.query("SELECT count(*)::int n FROM shared_provider_dispatches WHERE state='settled'")).rows[0].n,4)
})

test('a shared Responses model can return one JSON document for a streaming request',async t=>{
 const body=JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'已完成'}]}],usage:{input_tokens:4,output_tokens:2}})
 const bytes=Buffer.from(body),split=bytes.indexOf(Buffer.from('已'))+1
 const network=mockProviderNetwork(t,[bytes.subarray(0,split),bytes.subarray(split)],{contentType:'application/json; charset=utf-8'})
 const f=await fixture(t,{...entry,providerId:'openai',model:'gpt-4.1',baseUrl:'https://provider.example/v1'})
 const response=await f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:f.headers(f.alice),payload:{
  turnId:randomUUID(),modelId:entry.id,request:{system:'Office',messages:[{role:'user',text:'Read the summary'}],tools:[]}
 }})
 assert.match(response.body,/event: delta\ndata: {"text":"已完成"}/)
 assert.match(response.body,/event: usage\ndata: {"inputTokens":4,"outputTokens":2}/)
 assert.doesNotMatch(response.body,/event: error/)
 assert.equal(network.writes,1)
 const upstream=JSON.parse(network.wire)
 assert.equal(upstream.model,'gpt-4.1')
 assert.equal(upstream.reasoning,undefined)
 assert.equal(upstream.include,undefined)
})

test('the PDF editor continues both signed tool calls from Responses item completion events',async t=>{
 const tool={name:'read_pages',description:'Read pages',inputSchema:{type:'object',properties:{start:{type:'integer'}}}}
 const items=[1,2].flatMap(n=>[
  {type:'reasoning',id:'rs_'+n,encrypted_content:'sealed-'+n,summary:[]},
  {type:'function_call',id:'fc_'+n,call_id:'call_'+n,name:tool.name,arguments:JSON.stringify({start:n})},
 ])
 const frame=value=>'data: '+JSON.stringify(value)+'\n\n'
 const sent=[]
 const network=mockProviderNetwork(t,()=>{
  sent.push(JSON.parse(network.wire))
  const frames=sent.length===1
   ? [{type:'response.reasoning_summary_text.delta',output_index:0,delta:'Read the pages'},
      ...items.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),
      {type:'response.completed',response:{status:'completed'}}]
   : [{type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Read both pages.'}]}]}}]
  return Readable.from([Buffer.from(frames.map(frame).join(''))])
 })
 const f=await fixture(t,{...entry,baseUrl:'https://provider.example/v1',model:'deepseek-v4-flash'})
 const headers=f.headers(f.alice)
 const client=await createAssistantClient({
  format:'pdf',nativeToolNames:new Set([tool.name]),nativeDocumentEditing:true,csrfToken:headers['x-csrf-token'],
  request:async url=>(await f.app.inject({url,headers})).json(),
  fetchImpl:async(url,init)=>{
   const reply=await f.app.inject({method:init.method,url,headers:{...headers,...init.headers},payload:init.body})
   return new Response(reply.body,{status:reply.statusCode,headers:{'content-type':reply.headers['content-type']}})
  },
 })
 try {
  const pages=[]
  const result=await new Promise((resolve,reject)=>{
   const loop=new AgentLoop({transport:client.transport,skill:{
    id:'pdf',systemPrompt:'Read the PDF',tools:[tool],buildContext:()=>'',
    executeTool(call){pages.push(call.input.start);return {output:'Page '+call.input.start,summary:'Read page'}},
   },events:{onDone:resolve,onError:message=>reject(Error(message))}})
   loop.run('Read the first two pages')
  })
  assert.equal(result.text,'Read both pages.')
  assert.deepEqual(pages,[1,2])
  assert.equal(sent.length,2)
  assert.deepEqual(sent[1].input.filter(item=>item.type).map(item=>[item.type,item.encrypted_content??item.call_id]),[
   ['reasoning','sealed-1'],['function_call','call_1'],['reasoning','sealed-2'],['function_call','call_2'],
   ['function_call_output','call_1'],['function_call_output','call_2'],
  ])
 }finally{client.dispose()}
})
