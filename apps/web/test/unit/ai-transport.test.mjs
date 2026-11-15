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
