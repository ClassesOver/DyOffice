import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseAgentTransport } from '../../../../packages/browser-host/src/ai-transport.ts'

const stream = text => new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode(text));controller.close()}}),{headers:{'Content-Type':'text/event-stream'}})
const event = (name,data) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'
const callbackRecorder = () => {
  const calls=[]
  return {calls, callbacks:{onDelta:x=>calls.push(['delta',x]),onReasoning:x=>calls.push(['reasoning',x]),onToolCall:x=>calls.push(['tool_call',x]),onPhase:x=>calls.push(['phase',x]),onUsage:x=>calls.push(['usage',x]),onStopReason:x=>calls.push(['stop_reason',x]),onDone:()=>calls.push(['done']),onError:x=>calls.push(['error',x])}}
}
const delay = () => new Promise(resolve=>setTimeout(resolve,30))

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
