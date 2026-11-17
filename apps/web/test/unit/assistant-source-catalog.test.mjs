import test from 'node:test'
import assert from 'node:assert/strict'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'

const catalog = enabled => ({entries: [{id:'chat',label:'Chat',model:'synthetic'}],defaultId:'chat',...(enabled?{sourceCatalog:true}:{})})
const call = input => ({id:'call1',name:'sources_list',input})
test('source catalog skill is absent by default and appears only after explicit server advertisement',async()=>{
 const off=await createAssistantClient({request:async()=>catalog(false),csrfToken:'c'.repeat(43)})
 assert.equal(off.sourceSkill,undefined)
 const on=await createAssistantClient({request:async()=>catalog(true),csrfToken:'c'.repeat(43)})
 assert.deepEqual(on.sourceSkill?.tools.map(t=>t.name),['sources_list'])
})
test('source listing sends only validated pagination through the bound request and projects metadata',async()=>{
 const requests=[]
 const client=await createAssistantClient({csrfToken:'c'.repeat(43),request:async(path,method,body)=>{
  requests.push({path,method,body})
  return path.endsWith('/catalog')?catalog(true):{items:[{sourceId:'demo',name:'Demo',kind:'postgres',sourceVersion:1,secret:'never-return',url:'https://private.invalid'}],nextCursor:null}
 }})
 const result=await client.sourceSkill?.executeTool(call({after:'previous'}))
 assert.equal(result?.isError,undefined)
 assert.deepEqual(JSON.parse(result.output),{items:[{sourceId:'demo',name:'Demo',kind:'postgres',sourceVersion:1}],nextCursor:null})
 assert.deepEqual(requests[1],{path:'/api/v1/ai/sources/list',method:'POST',body:{after:'previous'}})
 for(const input of [{ownerId:'other'},{after:5},{after:'../bad'},42,true,'text'])assert.equal((await client.sourceSkill.executeTool(call(input))).isError,true)
 assert.equal((await client.sourceSkill.executeTool({...call({}),name:'sources_query'})).isError,true)
 assert.equal(requests.length,2)
 client.dispose()
 assert.equal((await client.sourceSkill.executeTool(call({}))).isError,true)
 assert.equal(requests.length,2)
})
test('source-list failure and cancellation do not expose response data or raw error details',async()=>{
 const control=new AbortController()
 let finish
 const client=await createAssistantClient({csrfToken:'c'.repeat(43),request:async path=>path.endsWith('/catalog')?catalog(true):new Promise(resolve=>{finish=resolve})})
 const pending=client.sourceSkill?.executeTool(call({}),control.signal)
 assert.equal(typeof finish,'function')
 control.abort();finish({items:[{sourceId:'hidden',name:'hidden',kind:'http',sourceVersion:1}],nextCursor:null})
 const outcome=await pending
 assert.equal(outcome.isError,true);assert.doesNotMatch(outcome.output,/hidden/)
})

test('source capability is offered only when enabled and valid in model tool-result history',async()=>{
 const {buildOpenAiChatRequest}=await import('../../server/src/modules/providers/openai-request.ts')
 const {assistantReadTools}=await import('../../../../packages/web-contracts/src/assistant.ts')
 for(const enabled of [false,true]){
  let sent
  const client=await createAssistantClient({request:async()=>catalog(enabled),csrfToken:'c'.repeat(43),fetchImpl:async(_url,init)=>{
   sent=JSON.parse(init.body).request
   return new Response('event: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
  }})
  await new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'list sources'}],tools:[{name:'sources_list',description:'List',inputSchema:{type:'object'}},{name:'sources_query',description:'Query',inputSchema:{type:'object'}}]}, {onDelta(){},onToolCall(){},onError:assert.fail,onDone:resolve}))
  assert.deepEqual(sent.tools.map(t=>t.name),enabled?['sources_list']:[])
  const history={...sent,messages:[{role:'user',text:'list sources'},{role:'assistant',text:'',toolCalls:[call({})]},{role:'tool',results:[{id:'call1',name:'sources_list',output:'{"items":[],"nextCursor":null}'}]}]}
  if(enabled)assert.doesNotThrow(()=>buildOpenAiChatRequest(history,{model:'test',maxOutputTokens:10},assistantReadTools(true)))
  else assert.throws(()=>buildOpenAiChatRequest(history,{model:'test',maxOutputTokens:10},assistantReadTools(false)))
 }
})

test('editor-bound source list discards response after account replacement',async()=>{
 const {createLocalShellClient}=await import('../../src/shell/local-client.ts')
 let proof='a'.repeat(43)
 const local=createLocalShellClient(async(path,init)=>{
  if(path.endsWith('/session-proof'))return Response.json({csrfToken:proof})
  assert.equal(init.headers['X-CSRF-Token'],'a'.repeat(43))
  if(path.endsWith('/catalog'))return Response.json(catalog(true))
  proof='b'.repeat(43)
  return Response.json({items:[{sourceId:'other',name:'other-account',kind:'http',sourceVersion:1}],nextCursor:null})
 })
 const bound=await local.bindSession()
 const client=await createAssistantClient({request:bound.request,csrfToken:bound.proof})
 const result=await client.sourceSkill.executeTool(call({}))
 assert.equal(result.isError,true);assert.doesNotMatch(result.output,/other-account/)
})
