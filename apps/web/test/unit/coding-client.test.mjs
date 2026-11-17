import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
const descriptors=[{id:'codex',name:'Codex',origin:'builtin',capabilities:['coding']},{id:'remote',name:'Remote',origin:'external',capabilities:['coding']}]
const catalog={entries:[{id:'office-model',label:'Original',model:'original'}],defaultId:'office-model',agents:descriptors,defaultAgentId:'codex'}
const stream=client=>new Promise(resolve=>client.transport.stream({system:'Office system',messages:[{role:'user',text:'read document'}],tools:[{name:'read_blocks',description:'Read',inputSchema:{}},...client.extraSkills.flatMap(s=>s.tools)]},{onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
const response=(event,value)=>new Response('event: '+event+'\ndata: '+JSON.stringify(value)+'\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
test('Office retains its selected model and only delegates when its skill is invoked',async()=>{
 const sent=[]
 const client=await createAssistantClient({request:async()=>catalog,csrfToken:'c'.repeat(43),fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);sent.push({url,body})
  return url==='/api/v1/agents/tasks'?response('delta',{text:JSON.stringify({summary:body.modelId,output:'tested code'})}):response('delta',{text:'Office answer'})
 }})
 assert.equal(sent.length,0);assert.equal(client.selected(),'office-model')
 await stream(client)
 assert.deepEqual(sent.map(x=>x.url),['/api/v1/ai/turns'])
 assert.equal(sent[0].body.modelId,'office-model')
 assert.deepEqual(sent[0].body.request.tools.map(t=>t.name),['read_blocks','list_agent_data','list_agents','delegate_agent_task'])
 const skill=client.extraSkills[0]
 const listed=await skill.executeTool({id:'list',name:'list_agents',input:{}})
 assert.deepEqual(JSON.parse(listed.output),descriptors);assert.equal(sent.length,1)
 for(const agentId of [undefined,'remote']) {
  const result=await skill.executeTool({id:'code',name:'delegate_agent_task',input:{instruction:'make parser',...(agentId?{agentId}:{})}})
  assert.equal(result.isError,undefined);assert.equal(result.mutated,undefined)
 }
 assert.deepEqual(sent.slice(1).map(x=>x.body.modelId),['codex','remote'])
 assert.deepEqual(sent.slice(1).map(x=>JSON.parse(x.body.request.messages[0].text).officeModelId),['office-model','office-model'])
 assert.deepEqual(sent[1].body.request.tools,[])
 assert.equal(client.selected(),'office-model');client.dispose()
})
test('delegation shares the model selected for this Office run, including after a picker change',async()=>{
 const sent=[]
 const client=await createAssistantClient({request:async()=>({...catalog,entries:[...catalog.entries,{id:'next-model'}]}),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(JSON.parse(init.body).request.messages[0].text).officeModelId)
  return response('delta',{text:JSON.stringify({summary:'ok',output:''})})
 }})
 const delegate=()=>client.extraSkills[0].executeTool({id:'code',name:'delegate_agent_task',input:{instruction:'code'}})
 client.select('next-model');await delegate()
 client.transport.beginRun();await delegate()
 assert.deepEqual(sent,['office-model','next-model']);client.dispose()
})
test('coding failure leaves ordinary Office model requests usable',async()=>{
 const urls=[]
 const client=await createAssistantClient({request:async()=>catalog,csrfToken:'c'.repeat(43),fetchImpl:async url=>{urls.push(url);return url==='/api/v1/agents/tasks'?response('error',{message:'offline'}):response('delta',{text:'Office still works'})}})
 const result=await client.extraSkills[0].executeTool({id:'code',name:'delegate_agent_task',input:{instruction:'code'}})
 assert.equal(result.isError,true)
 await stream(client);assert.deepEqual(urls,['/api/v1/agents/tasks','/api/v1/ai/turns']);client.dispose()
})
test('without agents the original assistant offers no delegation tools',async()=>{
 const client=await createAssistantClient({request:async()=>({entries:catalog.entries,defaultId:catalog.defaultId}),csrfToken:'c'.repeat(43)})
 assert.deepEqual(client.extraSkills,[]);assert.equal(client.available,true);client.dispose()
})
test('cancelling a delegated task sends cancellation on its own endpoint',async()=>{
 const urls=[];let started
 const ready=new Promise(resolve=>{started=resolve})
 const client=await createAssistantClient({request:async()=>catalog,csrfToken:'c'.repeat(43),fetchImpl:async(url,init)=>{
  urls.push(url)
  if(url.endsWith('/cancel'))return new Response('{}')
  started();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))
 }})
 const controller=new AbortController()
 const pending=client.extraSkills[0].executeTool({id:'code',name:'delegate_agent_task',input:{instruction:'code'}},controller.signal)
 await ready;controller.abort();assert.equal((await pending).isError,true)
 assert.equal(urls.length,2);assert.match(urls[1],/^\/api\/v1\/agents\/tasks\/[^/]+\/cancel$/);client.dispose()
})

test('Office discovers only metadata and passes explicit data scope to either peer',async()=>{
 const requests=[],sent=[]
 const resultId='11111111-1111-4111-8111-111111111111'
 const client=await createAssistantClient({csrfToken:'c'.repeat(43),request:async(path,method,body)=>{
  requests.push({path,method,body})
  if(path==='/api/v1/ai/catalog')return catalog
  if(path.includes('source-tools'))return {items:[{sourceId:'sales',name:'Sales'}],nextCursor:null}
  return {items:[{resultId,rowCount:3,truncated:false}],nextCursor:null}
 },fetchImpl:async(_url,init)=>{
  sent.push(JSON.parse(JSON.parse(init.body).request.messages[0].text))
  return response('delta',{text:JSON.stringify({summary:'analyzed',output:'total=6'})})
 }})
 const skill=client.extraSkills[0]
 const listed=await skill.executeTool({id:'catalog',name:'list_agent_data',input:{}})
 assert.equal(listed.isError,undefined);assert.doesNotMatch(listed.output,/'rows'|'preview'/)
 assert.deepEqual(requests[1].body,{name:'sources.list',arguments:{}})
 for(const agentId of ['codex','remote'])await skill.executeTool({id:'a',name:'delegate_agent_task',input:{instruction:'Analyze',agentId,dataInputs:{sourceIds:['sales'],resultIds:[resultId]}}})
 assert.deepEqual(sent.map(x=>x.dataInputs),[{sourceIds:['sales'],resultIds:[resultId]},{sourceIds:['sales'],resultIds:[resultId]}])
 client.dispose()
})

test('delivery observation receives only a server result hint and does not break successful Office work',async()=>{
 const seen=[]
 const delivery={commandId:'00000000-0000-4000-8000-000000000003',taskId:'00000000-0000-4000-8000-000000000001'}
 const client=await createAssistantClient({request:async()=>catalog,csrfToken:'c'.repeat(43),onDelivery:(hint,agent)=>{seen.push({hint,agent});throw Error('presentation unavailable')},fetchImpl:async()=>response('delta',{text:JSON.stringify({summary:'Done',output:'',delivery})})})
 const result=await client.extraSkills[0].executeTool({id:'run',name:'delegate_agent_task',input:{instruction:'analyze'}})
 assert.equal(result.isError,undefined);assert.equal(seen.length,1);assert.deepEqual(seen[0].hint,delivery);assert.equal(seen[0].agent.id,'codex');client.dispose()
})
