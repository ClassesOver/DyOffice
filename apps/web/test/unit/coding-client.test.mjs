import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
import {createCodingClient} from '../../../../packages/browser-host/src/coding.ts'
import {AgentLoop} from '../../../../packages/agent-core/src/loop.ts'
import {bindFileChat} from '../../../../packages/agent-core/src/file-chat.ts'
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
test('the task card shows the same ID used by execution and cancellation',async()=>{
 const urls=[];let started,turnId
 const ready=new Promise(resolve=>{started=resolve})
 const client=await createAssistantClient({request:async()=>catalog,csrfToken:'c'.repeat(43),fetchImpl:async(url,init)=>{
  urls.push(url)
  if(url.endsWith('/cancel'))return new Response('{}')
  turnId=JSON.parse(init.body).turnId
  started();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))
 }})
 const controller=new AbortController()
 const pending=client.extraSkills[0].executeTool({id:'code',name:'delegate_agent_task',input:{instruction:'code'}},controller.signal)
 await ready
 const cardId=client.coding.snapshot()[0].id
 controller.abort();assert.equal((await pending).isError,true)
 assert.equal(cardId,turnId)
 assert.deepEqual(urls,['/api/v1/agents/tasks','/api/v1/agents/tasks/'+cardId+'/cancel'])
 client.dispose()
})

test('closing the document observer keeps its task ID and reopening reads the original task without dispatching',async t=>{
 const documentId='10000000-0000-4000-8000-000000000001',calls=[],saved=new Map()
 const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)}
 let dispatch
 const ready=new Promise(resolve=>{dispatch=resolve})
 let id
 const fetchImpl=async(url,init)=>{
  calls.push({url,method:init.method})
  if(init.method==='POST'){
   const request=JSON.parse(init.body)
   id=request.turnId;dispatch(request)
   return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('disconnected')),{once:true}))
  }
  return Response.json({turnId:id,documentId,agentId:'codex',instruction:'Compute the total',state:'succeeded',activity:'Collecting task results',result:{summary:'Finished',output:'42'}})
 }
 const create=()=>createCodingClient({agents:descriptors,defaultId:'codex',documentId,storage,csrfToken:'c'.repeat(43),getModelId:()=> 'office-model',fetchImpl})
 const first=create(),pending=first.run({instruction:'Compute the total'}).catch(error=>error)
 t.after(()=>first.dispose())
 assert.equal((await ready).documentId,documentId)
 first.dispose()
 await pending
 assert.doesNotMatch(JSON.stringify([...saved]),/Compute the total|cccccccc/)
 const reopened=create()
 try{
  for(let i=0;i<20&&!reopened.snapshot().length;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(reopened.snapshot()[0].id,id)
  assert.equal(reopened.snapshot()[0].state,'succeeded')
  assert.equal(reopened.snapshot()[0].output,'42')
  assert.deepEqual(calls,[{url:'/api/v1/agents/tasks',method:'POST'},{url:'/api/v1/agents/tasks/'+id+'/status?documentId='+documentId,method:'GET'}])
 }finally{reopened.dispose()}
})

test('cancelling a recovered running task targets its original ID without submitting work',async t=>{
 const documentId='10000000-0000-4000-8000-000000000001',turnId='10000000-0000-4000-8000-000000000002'
 const calls=[],storage={getItem:()=>JSON.stringify([turnId]),setItem(){}},base='/api/v1/agents/tasks/'+turnId
 let cancelled=false,finish
 const terminal=new Promise(resolve=>{finish=resolve})
 const client=createCodingClient({agents:descriptors,defaultId:'codex',documentId,storage,csrfToken:'c'.repeat(43),getModelId:()=> 'office-model',fetchImpl:async(url,init)=>{
  calls.push([init.method,url])
  if(url===base+'/cancel'){
   cancelled=true
   return Response.json({})
  }
  return Response.json({turnId,documentId,agentId:'codex',instruction:'Compute the total',state:cancelled?'unknown_outcome':'running',failure:cancelled?'Harness cancellation requested. Check for saved delivery.':undefined})
 }})
 t.after(()=>client.dispose())
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(client.snapshot()[0]?.state,'running')
 const off=client.subscribe(()=>{const [card]=client.snapshot();if(card?.state==='unknown_outcome')finish(card)})
 t.after(off)
 await client.cancel(turnId)
 const card=await Promise.race([terminal,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Expected cancelled task status')),3000);timer.unref()})])
 assert.equal(card.id,turnId)
 assert.equal(card.failure,'Harness cancellation requested. Check for saved delivery.')
 assert.deepEqual(calls,[['GET',base+'/status?documentId='+documentId],['POST',base+'/cancel'],['GET',base+'/status?documentId='+documentId]])
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

for(const mode of ['stream','rejected','disconnected'])test('a finished task '+({stream:'enters the original Office model once',rejected:'does not continue after model admission is rejected',disconnected:'continues through the status endpoint after the observer loses SSE'}[mode]),{timeout:5000},async t=>{
 const documentId='10000000-0000-4000-8000-000000000001',revision='10000000-0000-4000-8000-000000000003'
 const calls=[]
 let dispatch
 let finish
 const done=new Promise(resolve=>{finish=resolve})
 const client=await createAssistantClient({request:async()=>catalog,documentId,continuationRevision:()=>revision,csrfToken:'c'.repeat(43),fetchImpl:async(url,init)=>{
  const body=init.body?JSON.parse(init.body):undefined;calls.push({url,body})
  if(init.method==='GET')return Response.json({turnId:dispatch.turnId,documentId,agentId:'codex',state:'succeeded',hasContinuation:true,continuationModelId:'office-model',result:{summary:'Finished',output:'42'}})
  if(url==='/api/v1/ai/turns'){
   if(!dispatch)return response('tool_call',{id:'original-tool',name:'delegate_agent_task',input:{instruction:'Compute'}})
   if(mode==='rejected')return new Response(null,{status:409})
   return response('delta',{text:'Office reused the result'})
  }
  assert.equal(url,'/api/v1/agents/tasks')
  dispatch=body
  if(mode==='disconnected')throw TypeError('Connection lost')
  return response('delta',{text:JSON.stringify({summary:'Finished',output:'42'})})
 }})
 t.after(()=>client.dispose())
 const {transport}=client
 const chatTurnId='10000000-0000-4000-8000-000000000004'
 t.after(bindFileChat(transport,()=>({turnId:chatTurnId,async history(){return []},text(){},finish(){}})))
 const loop=new AgentLoop({allowHarnessResume:true,skill:client.extraSkills[0],events:{onDone:finish,onError:error=>finish({error})},transport})
 loop.run('Private original Office request',undefined,undefined,{text:'Private original Office request'})
 const outcome=await done
 const requests=calls.filter(call=>call.url==='/api/v1/ai/turns').map(call=>call.body)
 assert.equal(dispatch.continuation.revision,revision)
 assert.equal(dispatch.continuation.checkpoint.chatTurnId,chatTurnId)
 assert.equal(dispatch.continuation.checkpoint.messages[0].text,'Private original Office request')
 assert.equal(requests.length,2)
 assert.deepEqual(requests[1].harnessResume,{taskId:dispatch.turnId,documentId,revision})
 assert.equal(requests[1].modelId,'office-model')
 assert.equal(requests[1].request.messages.at(-1).results[0].id,'original-tool')
 if(mode!=='rejected'){
  assert.equal(outcome.text,'Office reused the result')
 }else{
  assert.match(outcome.error,/409/)
 }
 assert.equal(client.coding.snapshot()[0].state,'succeeded')
 assert.equal(calls.filter(call=>call.url==='/api/v1/agents/tasks').length,1)
})

test('delivery observation receives only a server result hint and does not break successful Office work',async()=>{
 const seen=[]
 const delivery={commandId:'00000000-0000-4000-8000-000000000003',taskId:'00000000-0000-4000-8000-000000000001'}
 const client=await createAssistantClient({request:async()=>catalog,csrfToken:'c'.repeat(43),onDelivery:(hint,agent)=>{seen.push({hint,agent});throw Error('presentation unavailable')},fetchImpl:async()=>response('delta',{text:JSON.stringify({summary:'Done',output:'',delivery})})})
 const result=await client.extraSkills[0].executeTool({id:'run',name:'delegate_agent_task',input:{instruction:'analyze'}})
 assert.equal(result.isError,undefined);assert.equal(seen.length,1);assert.deepEqual(seen[0].hint,delivery);assert.equal(seen[0].agent.id,'codex');client.dispose()
})
