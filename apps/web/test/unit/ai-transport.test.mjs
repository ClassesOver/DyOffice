import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseAgentTransport } from '../../../../packages/browser-host/src/ai-transport.ts'
import { createAssistantClient } from '../../../../packages/browser-host/src/assistant.ts'
import { AgentLoop } from '@genoffice/agent-core'
import { createFileChat } from '../../src/editors/file-chat.ts'

const stream = text => new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode(text));controller.close()}}),{headers:{'Content-Type':'text/event-stream'}})
const event = (name,data) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'
const callbackRecorder = () => {
  const calls=[]
  return {calls, callbacks:{onDelta:x=>calls.push(['delta',x]),onReasoning:x=>calls.push(['reasoning',x]),onToolCall:x=>calls.push(['tool_call',x]),onPhase:x=>calls.push(['phase',x]),onUsage:x=>calls.push(['usage',x]),onStopReason:x=>calls.push(['stop_reason',x]),onDone:()=>calls.push(['done']),onError:x=>calls.push(['error',x])}}
}
const delay = () => new Promise(resolve=>setTimeout(resolve,30))

test('Office answers when transcript sync stalls and saves the turn after sync recovers',{timeout:9000},async t=>{
  const answer=Promise.withResolvers(),persisted=Promise.withResolvers()
  const deadline=setTimeout(()=>answer.reject(Error('Office never started the model turn while transcript sync stalled')),8000)
  t.after(()=>clearTimeout(deadline))
  const sent=[]
  const client=await createAssistantClient({
    request:async()=>({entries:[{id:'office-model'}],defaultId:'office-model'}),
    format:'pdf',csrfToken:'c'.repeat(43),
    fetchImpl:async(url,init)=>{
      sent.push([url,JSON.parse(init.body).request.messages.at(-1).text])
      return stream(event('delta',{text:'The page is ready to review.'})+event('done',{}))
    },
  })
  let stalled=false
  const chat=createFileChat('pdf-fixture',client.transport,async(_path,_method,{after,updates},signal)=>{
    if(!stalled){
      stalled=true
      return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
    }
    if(updates.some(message=>message.role==='assistant'&&message.state==='done'))persisted.resolve(updates)
    return {cursor:after+updates.length,hasMore:false,messages:updates.map((message,index)=>({...message,order:after+index+1}))}
  })
  t.after(()=>{chat.dispose();client.dispose()})
  const loop=new AgentLoop({transport:client.transport,skill:{id:'office',systemPrompt:'',tools:[],executeTool:assert.fail},events:{onDone:answer.resolve,onError:answer.reject}})
  loop.run('Review this PDF',undefined,undefined,{text:'Review this PDF'})
  assert.equal((await answer.promise).text,'The page is ready to review.')
  assert.deepEqual(sent,[['/api/v1/ai/turns','Review this PDF']])
  const updates=await persisted.promise
  assert.equal(new Set(updates.map(message=>message.turnId)).size,1)
  assert.deepEqual(updates.map(({role,state,text})=>[role,state,text]),[
    ['user','done','Review this PDF'],['assistant','done','The page is ready to review.'],
  ])
})

test('a standalone PPTX generation can finish after the normal browser deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const client=await createAssistantClient({
    request:async()=>({entries:[{id:'page-model'}],defaultId:'page-model'}),
    format:'pptx',csrfToken:'c'.repeat(43),
    fetchImpl:async url=>{
      if(url.endsWith('/cancel'))return new Response(null,{status:204})
      return new Promise(resolve=>setTimeout(()=>resolve(stream(event('delta',{text:'page JSON'})+event('done',{}))),121000))
    },
  })
  t.after(()=>client.dispose())
  const {calls,callbacks}=callbackRecorder()
  const done=new Promise(resolve=>client.transport.stream({system:'',messages:[{role:'user',text:'Design one editable slide'}],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}))
  await Promise.resolve()
  t.mock.timers.tick(121000)
  await done
  assert.deepEqual(calls,[['delta','page JSON'],['done']])
})

test('streams SSE in order and preserves completed tool calls',async()=>{
  let request
  const text=event('delta',{text:'你好'})+event('reasoning',{text:'internal'})+event('tool_call',{id:'c1',name:'read_doc',input:{block:1}})+event('usage',{inputTokens:2})+event('done',{})
  const transport=createSseAgentTransport({fetchImpl:async(url,init)=>{request={url,init};return stream(text)},createTurnId:()=> 't1'})
  const {calls,callbacks}=callbackRecorder()
  transport.stream({system:'s',messages:[],tools:[]},callbacks)
  await delay()
  assert.equal(request.url,'/api/v1/ai/turns')
  assert.equal(request.init.credentials,'same-origin')
  assert.equal(JSON.parse(request.init.body).turnId,'t1')
  assert.deepEqual(calls.map(x=>x[0]),['delta','reasoning','tool_call','usage','done'])
})

test('missing done event is an error and finishes exactly once', async()=>{
  const transport=createSseAgentTransport({fetchImpl:async()=>stream(event('delta',{text:'x'}))})
  const {calls,callbacks}=callbackRecorder()
  transport.stream({system:'',messages:[],tools:[]},callbacks)
  await delay()
  assert.deepEqual(calls.map(x=>x[0]),['delta','error','done'])
})

test('localizes a known provider failure without replaying the request or executing a tool',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document')
  Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{lang:'zh-CN'}}})
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document})
  let attempts=0
  const transport=createSseAgentTransport({fetchImpl:async()=>{
    attempts++
    return stream(event('error',{reason:'PROVIDER_RATE_LIMITED',message:'English fallback'})+event('tool_call',{id:'c1',name:'write',input:{}})+event('done',{}))
  }})
  const {calls,callbacks}=callbackRecorder()
  await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}))
  assert.deepEqual(calls,[['error','模型供应商限流或额度不足，请稍后重试或切换模型。'],['done']])
  assert.equal(attempts,1)
})

test('localizes Office model timeouts from both the server and browser deadlines',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document')
 Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{lang:'zh-CN'}}})
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document})
 for(const serverDeadline of [true,false]){
  const requests=[]
  const transport=createSseAgentTransport({timeoutMs:serverDeadline?1000:20,createTurnId:()=> 'timeout',fetchImpl:async(url,init)=>{
   requests.push(url)
   if(url.endsWith('/cancel'))return new Response(null,{status:204})
   if(serverDeadline)return stream(event('delta',{text:'partial reply'})+event('error',{reason:'AI_TURN_TIMED_OUT',message:'AI turn timed out'})+event('done',{}))
   return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))
  }})
  const {calls,callbacks}=callbackRecorder()
  await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}))
  assert.deepEqual(calls.map(([kind])=>kind),serverDeadline?['delta','error','done']:['error','done'])
  assert.match(calls.at(-2)[1],/超时.*重试/)
  assert.deepEqual(requests,serverDeadline?['/api/v1/ai/turns']:['/api/v1/ai/turns','/api/v1/ai/turns/timeout/cancel'])
 }
})

test('a rejected Harness model admission cannot finalize the shared turn',async()=>{
  const harnessResume={taskId:'task',documentId:'document',revision:'revision'}
  const statuses=[]
  for(const response of [new Response(null,{status:409}),stream(event('error',{message:'Provider failed'}))]){
    const transport=createSseAgentTransport({harnessResume,fetchImpl:async(_url,init)=>{
      assert.deepEqual(JSON.parse(init.body).harnessResume,harnessResume)
      return response
    }})
    await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{
      onDelta(){},onToolCall(){},onError(message,disposition){statuses.push([message,disposition])},
      onDone(disposition){statuses.push(['done',disposition]);resolve()},
    }))
  }
  assert.deepEqual(statuses,[['AI stream HTTP 409','harness-admission-unconfirmed'],['done','harness-admission-unconfirmed'],['Provider failed',undefined],['done',undefined]])
})

test('cancel aborts stream and requests explicit server cancellation', async()=>{
  const requests=[]
  const transport=createSseAgentTransport({fetchImpl:async(url,init)=>{
    requests.push(url)
    if(url.endsWith('/cancel'))return new Response(null,{status:204})
    return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})})
  },createTurnId:()=> 't42'})
  const {calls,callbacks}=callbackRecorder()
  const handle=transport.stream({system:'s',messages:[],tools:[]},callbacks)
  await delay(); handle.cancel(); handle.cancel(); await delay()
  assert.deepEqual(requests,['/api/v1/ai/turns','/api/v1/ai/turns/t42/cancel'])
  assert.deepEqual(calls.map(x=>x[0]),['done'])
})

test('refuses cross-origin endpoints and non-SSE responses',async()=>{
  assert.throws(()=>createSseAgentTransport({endpoint:'https://evil.example/v1'}))
  assert.throws(()=>createSseAgentTransport({endpoint:'//evil.example/v1'}))
  const transport=createSseAgentTransport({fetchImpl:async()=>new Response('{}',{headers:{'Content-Type':'application/json'}})})
  const {calls,callbacks}=callbackRecorder()
  transport.stream({system:'',messages:[],tools:[]},callbacks)
  await delay()
  assert.deepEqual(calls.map(x=>x[0]),['error','done'])
})

test('multiple small SSE frames in one large network chunk remain valid', async()=>{
  const text = Array.from({length:4000},()=>event('delta',{text:'x'.repeat(64)})).join('') + event('done',{})
  const transport=createSseAgentTransport({fetchImpl:async()=>stream(text)})
  const {calls,callbacks}=callbackRecorder()
  transport.stream({system:'',messages:[],tools:[]},callbacks)
  await new Promise(resolve=>setTimeout(resolve,80))
  assert.equal(calls.filter(x=>x[0]==='delta').length,4000)
  assert.equal(calls.filter(x=>x[0]==='done').length,1)
  assert.equal(calls.filter(x=>x[0]==='error').length,0)
})

test('rejects URL-normalized cross-origin endpoints before sending prompts', () => {
  for (const endpoint of ['/\n/evil.example/turns', '/\r/evil.example/turns', '/\t/evil.example/turns']) {
    assert.equal(new URL(endpoint, 'https://app.example').origin, 'https://evil.example')
    assert.throws(() => createSseAgentTransport({endpoint}), /origin-relative/)
  }
})

test('stream and cancellation requests disallow redirects', async () => {
  const requests = []
  let started
  const ready = new Promise(resolve => { started = resolve })
  const transport = createSseAgentTransport({fetchImpl:async (url, init) => {
    requests.push({url, init})
    if (url.endsWith('/cancel')) return new Response(null, {status:204})
    started()
    return new Promise((resolve,reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')), {once:true}))
  },createTurnId:()=> 'redirect-test'})
  const {callbacks} = callbackRecorder()
  const handle = transport.stream({system:'private prompt',messages:[],tools:[]},callbacks)
  await ready
  handle.cancel()
  assert.equal(requests.length,2)
  for (const {init} of requests) {
    assert.equal(init.credentials,'same-origin')
    assert.equal(init.redirect,'error')
    assert.equal(init.mode,'same-origin')
    assert.equal(init.referrerPolicy, 'same-origin')
  }
})

test('307 and 308 cannot forward a model prompt to a second origin', async () => {
  const {createServer} = await import('node:http')
  let leakedRequests = 0
  const sink = createServer((req,res) => { leakedRequests++; req.resume();res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(event('done',{})) })
  const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const close = server => new Promise(resolve => server.close(resolve))
  await listen(sink)
  const sinkUrl = `http://127.0.0.1:${sink.address().port}/sink`
  let status = 307
  const origin = createServer((req,res) => { req.resume();res.writeHead(status,{Location:sinkUrl});res.end() })
  try {
    await listen(origin)
    for (status of [307,308]) {
      const calls=[]
      const transport=createSseAgentTransport({fetchImpl:(url,init)=>fetch(new URL(url,`http://127.0.0.1:${origin.address().port}`),init)})
      await new Promise(resolve => transport.stream({system:'test-only-private-prompt',messages:[],tools:[]},{onDelta(){},onToolCall(){},onError:error=>calls.push(error),onDone:resolve}))
      assert.equal(leakedRequests,0,`HTTP ${status} forwarded prompt`)
      assert.equal(calls.length,1)
    }
  } finally { await close(origin); await close(sink) }
})

test('unterminated multiline events fail at the cumulative byte limit and cancel the reader', async () => {
  let readerCancelled=false
  const body = new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode('event: delta\n' + ('data: ' + '字'.repeat(1024) + '\n').repeat(100)))
    // Keep open without the frame terminator, like a stalled or malicious provider.
  },cancel(){readerCancelled=true}})
  const transport=createSseAgentTransport({fetchImpl:async()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}})})
  const {calls,callbacks}=callbackRecorder()
  let handle
  let timeout
  try {
    await Promise.race([
      new Promise(resolve=> {handle=transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}})}),
      new Promise((resolve,reject)=> {timeout=setTimeout(()=>reject(new Error('oversized open frame was not rejected')),300)})
    ])
    assert.deepEqual(calls.map(x=>x[0]),['error','done'])
    assert.match(calls[0][1], /too large/)
    assert.equal(readerCancelled,true)
  } finally {clearTimeout(timeout);handle?.cancel()}
})

test('rejects query and fragment endpoints that cannot form a cancellation path', () => {
  for (const endpoint of ['/api/turns?mode=1','/api/turns#fragment','/api/turns?','/api/turns#']) {
    assert.throws(() => createSseAgentTransport({endpoint}), /origin-relative/)
  }
})

test('serializes only AgentStreamRequest fields, never client routing or credentials', async () => {
  let body
  const transport=createSseAgentTransport({format:'xlsx',fetchImpl:async(url,init)=>{body=JSON.parse(init.body);return stream(event('done',{}))}})
  await new Promise(resolve=>transport.stream({system:'s',messages:[],tools:[],apiKey:'secret',baseUrl:'https://evil.example',ownerId:'other'}, {...callbackRecorder().callbacks,onDone:resolve}))
  assert.deepEqual(body.request,{format:'xlsx',system:'s',messages:[],tools:[]})
})

test('timeout aborts stalled headers, emits one error/done and requests server cancellation once', async () => {
  const requests=[]
  let signal
  const transport=createSseAgentTransport({timeoutMs:10,createTurnId:()=> 'timeout',fetchImpl:async(url,init)=>{
    requests.push(url)
    if(url.endsWith('/cancel'))return new Response(null,{status:204})
    signal=init.signal
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))
  }})
  const {calls,callbacks}=callbackRecorder()
  const handle=transport.stream({system:'',messages:[],tools:[]},callbacks)
  await new Promise(resolve=>setTimeout(resolve,40))
  try {
    assert.deepEqual(calls.map(x=>x[0]),['error','done'])
    assert.match(calls[0][1],/timed out/)
    assert.equal(signal.aborted,true)
    handle.cancel()
    assert.deepEqual(requests,['/api/v1/ai/turns','/api/v1/ai/turns/timeout/cancel'])
  } finally {handle.cancel()}
})

test('timeout configuration must be finite and positive',()=>{
  for(const timeoutMs of [0,-1,Infinity,NaN,2147483648]) assert.throws(()=>createSseAgentTransport({timeoutMs}),/timeout/)
})

test('deadline also cancels a stalled response body and suppresses late terminal callbacks',async()=>{
  let readerCancelled=false
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(event('delta',{text:'partial'})))},cancel(){readerCancelled=true}})
  const transport=createSseAgentTransport({timeoutMs:10,fetchImpl:async(url)=>url.endsWith('/cancel')?new Response(null,{status:204}):new Response(body,{headers:{'content-type':'text/event-stream'}})})
  const {calls,callbacks}=callbackRecorder()
  transport.stream({system:'',messages:[],tools:[]},callbacks)
  await new Promise(resolve=>setTimeout(resolve,40))
  assert.deepEqual(calls.map(x=>x[0]),['delta','error','done'])
  assert.equal(readerCancelled,true)
})

test('successful completion clears deadline and does not send cancellation',async()=>{
  const requests=[]
  const transport=createSseAgentTransport({timeoutMs:10,fetchImpl:async(url)=>{requests.push(url);return stream(event('done',{}))}})
  const {calls,callbacks}=callbackRecorder()
  transport.stream({system:'',messages:[],tools:[]},callbacks)
  await new Promise(resolve=>setTimeout(resolve,40))
  assert.deepEqual(calls,[['done']])
  assert.equal(requests.length,1)
})

test('incomplete tool arguments fail closed; absent usage never manufactures billed tokens',async()=>{
  const transport=createSseAgentTransport({fetchImpl:async()=>stream(event('tool_call',{id:'t',name:'write',input:'{"broken":'})+event('done',{}))})
  const {calls,callbacks}=callbackRecorder()
  await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}))
  assert.deepEqual(calls.map(x=>x[0]),['error','done'])
})

test('late response after deadline emits no deltas and releases reader',async()=>{
  let deliver
  let readerCancelled=false
  const transport=createSseAgentTransport({timeoutMs:10,fetchImpl:async url=>url.endsWith('/cancel')?new Response(null,{status:204}):new Promise(resolve=>{deliver=resolve})})
  const {calls,callbacks}=callbackRecorder()
  transport.stream({system:'',messages:[],tools:[]},callbacks)
  await new Promise(resolve=>setTimeout(resolve,30))
  deliver(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(event('delta',{text:'late'})+event('done',{})))},cancel(){readerCancelled=true}}),{headers:{'content-type':'text/event-stream'}}))
  await delay()
  assert.deepEqual(calls.map(x=>x[0]),['error','done'])
  assert.equal(readerCancelled,true)
})

test('successful stream without usage does not invent zero usage',async()=>{
  const transport=createSseAgentTransport({fetchImpl:async()=>stream(event('delta',{text:'ok'})+event('done',{}))})
  const {calls,callbacks}=callbackRecorder()
  await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}))
  assert.deepEqual(calls.map(x=>x[0]),['delta','done'])
})

test('opt-in model selection and CSRF proof cover stream and cancellation requests',async()=>{
 const requests=[],proof='p'.repeat(43);let started;const ready=new Promise(r=>started=r)
 const transport=createSseAgentTransport({modelId:'enabled-model',getCsrfToken:async()=>proof,fetchImpl:async(url,init)=>{
  requests.push({url,init});if(url.endsWith('/cancel'))return new Response(null,{status:204});started();return new Promise(()=>{})
 }})
 const {callbacks}=callbackRecorder();const handle=transport.stream({system:'',messages:[],tools:[]},callbacks)
 await ready;handle.cancel();await delay()
 assert.equal(JSON.parse(requests[0].init.body).modelId,'enabled-model');assert.equal(requests.length,2)
 for(const {init} of requests)assert.equal(new Headers(init.headers).get('x-csrf-token'),proof)
})
test('malformed usage is rejected and complete tool calls project only candidate fields',async()=>{
 for(const usage of [{inputTokens:-1},{outputTokens:1.5},{inputTokens:'4'}]){
  const {calls,callbacks}=callbackRecorder();const transport=createSseAgentTransport({fetchImpl:async()=>stream(event('usage',usage)+event('done',{}))})
  await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}));assert.deepEqual(calls.map(x=>x[0]),['error','done'])
 }
 const {calls,callbacks}=callbackRecorder();const transport=createSseAgentTransport({fetchImpl:async()=>stream(event('tool_call',{id:'t',name:'read',input:{a:1},approved:true,apiKey:'private'})+event('done',{}))})
 await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}));assert.deepEqual(calls[0],['tool_call',{id:'t',name:'read',input:{a:1}}])
})

test('an error observer cannot suppress the exactly-once done callback',async()=>{
 let done=0
 const transport=createSseAgentTransport({fetchImpl:async()=>new Response(null,{status:503})})
 transport.stream({system:'',messages:[],tools:[]},{onDelta(){},onToolCall(){},onError(){throw Error('UI callback failed')},onDone(){done++}})
 await delay();assert.equal(done,1)
})
test('cancelling while CSRF proof is pending never sends a prompt afterwards',async()=>{
 let proof;const requests=[];const transport=createSseAgentTransport({modelId:'model',getCsrfToken:()=>new Promise(r=>proof=r),fetchImpl:async url=>{requests.push(url);return stream(event('done',{}))}})
 const {calls,callbacks}=callbackRecorder();const handle=transport.stream({system:'private',messages:[],tools:[]},callbacks)
 handle.cancel();proof('p'.repeat(43));await delay()
 assert.deepEqual(requests,[]);assert.deepEqual(calls,[['done']])
})


test('SSE done completes successfully and cancels the reader without waiting for network EOF', {timeout: 2000}, async () => {
  const cancelled = Promise.withResolvers()
  const requests = [], {calls, callbacks} = callbackRecorder()
  const transport = createSseAgentTransport({createTurnId: () => 'done-before-eof', fetchImpl: async (url, init) => {
    requests.push({url, init})
    return new Response(new ReadableStream({
      start(controller) {controller.enqueue(new TextEncoder().encode(event('delta', {text: 'complete'}) + event('done', {})))},
      cancel() {cancelled.resolve()},
    }), {headers: {'Content-Type': 'text/event-stream'}})
  }})
  transport.stream({system: '', messages: [], tools: []}, callbacks)
  await cancelled.promise
  assert.deepEqual(calls, [['delta', 'complete'], ['done']])
  assert.equal(requests.length, 1)
  assert.equal(JSON.parse(requests[0].init.body).turnId, 'done-before-eof')
})

test('an error event with an empty message still fails the turn exactly once',async()=>{
 for(const message of ['', '   ']){
  const transport=createSseAgentTransport({fetchImpl:async()=>stream(event('delta',{text:'partial'})+event('error',{message})+event('done',{}))})
  const {calls,callbacks}=callbackRecorder()
  await new Promise(resolve=>transport.stream({system:'',messages:[],tools:[]},{...callbacks,onDone(){callbacks.onDone();resolve()}}))
  assert.deepEqual(calls,[['delta','partial'],['error','AI stream failed'],['done']])
 }
})
