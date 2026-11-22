import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerProviderRoutes} from '../../server/src/modules/providers/routes.ts'
import {createCodingRecovery} from '../../../../packages/browser-host/src/coding-recovery.ts'

const DOC='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',ID='11111111-2222-4333-8444-555555555555'
const flush=async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve))}

function app(t,taskEvents){
 const server=Fastify();t.after(()=>server.close())
 registerProviderRoutes(server,{endpoint:'/api/v1/agents/tasks',turns:{run(){},cancel(){}},sessions:{authenticate:async()=>({})},csrf:{requireSession(){},requireSessionRead(){}},taskEvents})
 return server
}

test('the event stream resumes after a sequence and ends once the task is terminal',async t=>{
 const calls=[]
 const pages=[{state:'running',events:[{sequence:3,kind:'activity',payload:{text:'Testing'}}]},{state:'succeeded',events:[{sequence:4,kind:'state',payload:{state:'succeeded'}}]}]
 const server=app(t,async(token,id,documentId,after)=>{calls.push({token,id,documentId,after});return pages.shift()})
 const response=await server.inject({url:`/api/v1/agents/tasks/${ID}/events?documentId=${DOC}&after=2`,headers:{cookie:'__Host-dyoffice-session='+'s'.repeat(43)}})
 assert.equal(response.statusCode,200)
 assert.match(response.headers['content-type'],/text\/event-stream/)
 assert.deepEqual(calls.map(call=>call.after),[2,3])
 assert.equal(calls[0].documentId,DOC)
 assert.match(response.payload,/id: 3\nevent: task\ndata: \{"sequence":3/)
 assert.match(response.payload,/event: end\ndata: \{"state":"succeeded"\}/)
})

test('an unauthorized or unknown task is an ordinary HTTP error, not a stream',async t=>{
 const server=app(t,async()=>{throw Object.assign(Error('missing'),{statusCode:404})})
 const response=await server.inject({url:`/api/v1/agents/tasks/${ID}/events?documentId=${DOC}`,headers:{cookie:'__Host-dyoffice-session='+'s'.repeat(43)}})
 assert.equal(response.statusCode,404)
 assert.equal((await server.inject({url:`/api/v1/agents/tasks/${ID}/events?documentId=${DOC}&after=-1`,headers:{cookie:'__Host-dyoffice-session='+'s'.repeat(43)}})).statusCode,400)
})

function sse(frames){
 const body=frames.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
 return new Response(body,{status:200,headers:{'content-type':'text/event-stream'}})
}
const status=(state,extra={})=>new Response(JSON.stringify({turnId:ID,documentId:DOC,agentId:'codex',state,...extra}),{status:200})

test('the browser shows streamed progress and reads the final result from /status',async()=>{
 let state='running',statuses=0,streams=0
 const seen=[]
 const fetchImpl=async path=>{
  if(path.includes('/events')){
   streams++
   assert.match(path,/after=0/)
   state='succeeded'
   return sse([['task',{sequence:1,kind:'state',payload:{state:'running'}}],['task',{sequence:2,kind:'activity',payload:{text:'Running tests'}}],
    ['task',{sequence:3,kind:'progress',payload:{text:'ok 1\n'}}],['task',{sequence:4,kind:'progress',payload:{text:'ok 2\n'}}],['task',{sequence:5,kind:'state',payload:{state:'succeeded'}}]])
  }
  if(path.includes('/status')){statuses++;return state==='running'?status('running',{progress:'stale'}):status('succeeded',{result:{summary:'Done',output:'42'}})}
  return new Response(JSON.stringify({taskIds:[ID]}),{status:200})
 }
 const recovery=createCodingRecovery({documentId:DOC,fetchImpl,csrfToken:'c',onStatus:value=>seen.push(value)})
 const terminal=recovery.waitForTerminal(ID,new AbortController().signal)
 const result=await terminal
 assert.equal(result.state,'succeeded');assert.equal(result.result.output,'42')
 assert.equal(streams,1)
 assert.ok(seen.some(value=>value.state==='running'&&value.activity==='Running tests'&&value.progress==='ok 1\nok 2\n'),JSON.stringify(seen))
 // Terminal: no further status reads.
 const before=statuses;await flush();assert.equal(statuses,before)
 recovery.dispose()
})

test('without an event endpoint the browser keeps polling once a second',async()=>{
 mock.timers.enable({apis:['setTimeout']})
 try{
  let statuses=0,streams=0
  const fetchImpl=async path=>{
   if(path.includes('/events')){streams++;return new Response('missing',{status:404})}
   if(path.includes('/status')){statuses++;return status('running')}
   return new Response(JSON.stringify({taskIds:[ID]}),{status:200})
  }
  const recovery=createCodingRecovery({documentId:DOC,fetchImpl,csrfToken:'c',onStatus:()=>{}})
  await flush()
  for(let second=0;second<5;second++){mock.timers.tick(1000);await flush()}
  assert.equal(streams,1)
  assert.ok(statuses>=5,`status polls ${statuses}`)
  recovery.dispose()
 }finally{mock.timers.reset()}
})

test('an open stream replaces per-second polling except for the safety read',async()=>{
 mock.timers.enable({apis:['setTimeout']})
 try{
  let statuses=0,release
  const fetchImpl=async(path,init)=>{
   if(path.includes('/events'))return new Response(new ReadableStream({start(controller){release=()=>controller.close();init.signal.addEventListener('abort',()=>{try{controller.error(Error('aborted'))}catch{}})}}),{status:200,headers:{'content-type':'text/event-stream'}})
   if(path.includes('/status')){statuses++;return status('running')}
   return new Response(JSON.stringify({taskIds:[ID]}),{status:200})
  }
  const recovery=createCodingRecovery({documentId:DOC,fetchImpl,csrfToken:'c',onStatus:()=>{}})
  await flush()
  const first=statuses
  for(let second=0;second<20;second++){mock.timers.tick(1000);await flush()}
  // One safety read every ten polls instead of twenty reads.
  assert.ok(statuses-first<=2,`status polls ${statuses-first}`)
  recovery.dispose();try{release?.()}catch{/* already closed by abort */}
 }finally{mock.timers.reset()}
})

test('events can be turned off per browser',async()=>{
 let streams=0
 const fetchImpl=async path=>{if(path.includes('/events'))streams++;return path.includes('/status')?status('running'):new Response(JSON.stringify({taskIds:[ID]}),{status:200})}
 const recovery=createCodingRecovery({documentId:DOC,fetchImpl,csrfToken:'c',onStatus:()=>{},storage:{getItem:key=>key==='dyoffice.harness.events'?'off':'[]',setItem(){}}})
 await flush()
 assert.equal(streams,0)
 recovery.dispose()
})

test('a DSH stream resumes from the saved snapshot and only sends task change metadata',async t=>{
 const {registerAssistantChannelRoutes}=await import('../../server/src/modules/assistant-channel/routes.ts')
 const server=Fastify()
 t.after(()=>server.close())
 const reads=[]
 const service={async ownerEventPage(token,channelId,after){
  if(!token)throw Object.assign(Error('missing session'),{statusCode:403})
  assert.equal(token,'s'.repeat(43))
  assert.equal(channelId,DOC)
  reads.push(after)
  if(after===8)throw Object.assign(Error('access ended'),{statusCode:403})
  return {events:[{sequence:8,kind:'task.result',taskId:ID}]}
 }}
 registerAssistantChannelRoutes(server,service,{requireSessionRead(){}})
 const response=await server.inject({url:'/api/v1/assistant-channels/channels/'+DOC+'/events?after=7',headers:{cookie:'__Host-dyoffice-session='+'s'.repeat(43)}})
 assert.equal(response.statusCode,200)
 assert.deepEqual(reads,[7,8])
 assert.match(response.payload,/"kind":"task.result"/)
 assert.doesNotMatch(response.payload,/private document data/)
 const revoked=await server.inject({url:'/api/v1/assistant-channels/channels/'+DOC+'/events?after=8'})
 assert.equal(revoked.statusCode,403)
})

test('the DSH listener refreshes on a new complete event and stops on disposal',async()=>{
 const {followChannelEvents}=await import('../../../../packages/browser-host/src/channel-event-stream.ts')
 let controller,signal
 const seen=[]
 const stop=followChannelEvents('/channel/events','proof',()=>4,()=>seen.push('refresh'), async(path,init)=>{
  assert.equal(path,'/channel/events?after=4')
  assert.equal(init.headers['x-csrf-token'],'proof')
  signal=init.signal
  return new Response(new ReadableStream({start(c){controller=c}}),{headers:{'content-type':'text/event-stream'}})
 })
 try{
  const encode=text=>new TextEncoder().encode(text)
  controller.enqueue(encode('id: 4\nevent: task\n\nid: 5\nevent:'))
  await flush()
  assert.deepEqual(seen,[])
  controller.enqueue(encode(' task\n\n'))
  await flush()
  assert.deepEqual(seen,['refresh'])
 }finally{stop();controller.close()}
 assert.equal(signal.aborted,true)
})

test('the unified stream scopes identical IDs by document, conversation or channel feed',async t=>{
 const {registerTaskEventRoutes}=await import('../../server/src/modules/tasks/routes.ts')
 const server=Fastify();t.after(()=>server.close())
 const reads=[]
 const reader=source=>async(...args)=>{reads.push([source,...args]);return {state:'succeeded',events:[]}}
 const token='s'.repeat(43),headers={cookie:'__Host-dyoffice-session='+token}
 registerTaskEventRoutes(server,{requireSessionRead(){}},reader('coding'),reader('channel'))
 const get=query=>server.inject({url:'/api/v1/assistant/tasks/'+ID+'/events?'+query,headers})
 for(const query of ['documentId='+DOC,'conversationId='+DOC,'feed=channel']){
  const response=await get(query+'&after=7')
  assert.equal(response.statusCode,200);assert.match(response.payload,/event: end/)
 }
 assert.deepEqual(reads,[['coding',token,ID,DOC,7],['channel',token,DOC,7,ID],['channel',token,ID,7,undefined]])
 for(const query of ['','documentId='+DOC+'&conversationId='+DOC,'feed=channel&conversationId='+DOC,'feed=channel&after=9007199254740992'])
  assert.equal((await get(query)).statusCode,400)
})
