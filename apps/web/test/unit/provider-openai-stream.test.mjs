import test from 'node:test'
import assert from 'node:assert/strict'
import {parseOpenAiChatStream} from '../../server/src/modules/providers/openai-stream.ts'
const frame=value=>'data: '+(value==='[DONE]'?value:JSON.stringify(value))+'\n\n'
const choice=delta=>({choices:[{index:0,delta}]})
async function* chunks(text,step=7){const b=new TextEncoder().encode(text);for(let i=0;i<b.length;i+=step)yield b.slice(i,i+step)}
const collect=async(source,options)=>{const events=[];for await(const event of parseOpenAiChatStream(source,options))events.push(event);return events}
const done=frame('[DONE]')
test('incremental UTF8 delta, reasoning, complete tools and usage normalize without metadata',async()=>{
 const text=frame(choice({content:'你好',reasoning_content:'reason'}))+frame(choice({tool_calls:[{index:0,id:'candidate',function:{name:'read',arguments:'{"a":'}}]}))+frame(choice({tool_calls:[{index:0,function:{arguments:'1}'}}]}))+frame({choices:[{delta:{},finish_reason:'tool_calls'}]})+frame({choices:[],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5,secret:'never'}})+done
 assert.deepEqual(await collect(chunks(text,1)),[{type:'delta',text:'你好'},{type:'reasoning',text:'reason'},{type:'tool_call',id:'candidate',name:'read',input:{a:1}},{type:'usage',inputTokens:3,outputTokens:2}])
})
test('absent usage stays absent, never billed zero',async()=>{
 assert.deepEqual(await collect(chunks(frame(choice({content:'ok'}))+done)),[{type:'delta',text:'ok'}])
})
test('clean EOF accepts the complete finish frame and trailing usage without DONE',async()=>{
 const text=frame({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})
 const usage=frame({choices:[],usage:{prompt_tokens:3,completion_tokens:2}})
 assert.deepEqual(await collect(chunks(text+usage)),[{type:'delta',text:'ok'},{type:'usage',inputTokens:3,outputTokens:2}])
})
test('EOF emits tool candidates only after a matching finish frame and clean transport close',async()=>{
 const candidate=frame(choice({tool_calls:[{index:0,id:'c',function:{name:'read',arguments:'{}'}}]}))
 const finish=reason=>frame({choices:[{delta:{},finish_reason:reason}]})
 assert.deepEqual(await collect(chunks(candidate+finish('tool_calls'))),[{type:'tool_call',id:'c',name:'read',input:{}}])
 const disconnected=(async function*(){yield Buffer.from(candidate+finish('tool_calls'));throw Error('Disconnected')})()
 for(const source of [chunks(candidate),chunks(candidate+finish('stop')),chunks(candidate+finish('tool_calls')+'data: {'),chunks(candidate+finish('tool_calls').slice(0,-1)),disconnected]){
  const events=[]
  await assert.rejects(async()=>{for await(const event of parseOpenAiChatStream(source))events.push(event)},/Invalid provider stream/)
  assert.deepEqual(events,[])
 }
})
test('truncated arguments and missing completion marker fail closed before tool candidates',async()=>{
 for(const tail of ['',done]){
  const events=[]
  await assert.rejects(async()=>{for await(const event of parseOpenAiChatStream(chunks(frame(choice({tool_calls:[{index:0,id:'c',function:{name:'read',arguments:'{"partial":'}}]}))+tail)))events.push(event)},/^Error: Invalid provider stream$/)
  assert.deepEqual(events,[])
 }
 await assert.rejects(()=>collect(chunks(frame(choice({content:'partial'})))),/Invalid provider stream/)
})
test('all tools validate before any candidate is emitted',async()=>{
 const events=[]
 const text=frame(choice({tool_calls:[{index:0,id:'first',function:{name:'read',arguments:'{}'}},{index:1,id:'second',function:{name:'write',arguments:'{'}}]}))+done
 await assert.rejects(async()=>{for await(const e of parseOpenAiChatStream(chunks(text)))events.push(e)},/Invalid provider stream/);assert.deepEqual(events,[])
})
test('length truncation preserves partial text and usage without emitting any tool candidate',async()=>{
 for(const args of ['{}','{"text":'])for(const tail of ['',done]){
  const text=frame(choice({content:'partial',tool_calls:[{index:0,id:'c',function:{name:'write',arguments:args}}]}))
   +frame({choices:[{delta:{},finish_reason:'length'}]})+frame({choices:[],usage:{completion_tokens:16}})+tail
  assert.deepEqual(await collect(chunks(text)),[{type:'delta',text:'partial'},{type:'stop_reason',reason:'max_tokens'},{type:'usage',outputTokens:16}])
 }
})
test('bad JSON, error payload, malformed usage and unsupported choice shape are redacted',async()=>{
 for(const text of ['data: {secret\n\n'+done,frame({error:{message:'secret-key'}})+done,frame({choices:[],usage:{prompt_tokens:-1}})+done,frame({choices:[{index:1,delta:{content:'wrong'}}]})+done])
  await assert.rejects(()=>collect(chunks(text)),/^Error: Invalid provider stream$/)
})
test('total/frame/tool count budgets reject excess without unbounded accumulation',async()=>{
 await assert.rejects(()=>collect(chunks(frame(choice({content:'x'.repeat(200)}))+done),{maxBytes:128}),/Invalid provider stream/)
 await assert.rejects(()=>collect(chunks(frame(choice({content:'x'.repeat(200)}))+done),{maxFrameBytes:128}),/Invalid provider stream/)
 await assert.rejects(()=>collect(chunks(frame(choice({tool_calls:[{index:64,id:'x',function:{name:'read',arguments:'{}'}}]}))+done)),/Invalid provider stream/)
})
test('pre-abort and stalled-source cancellation reject and release iterator',async()=>{
 const before=new AbortController();before.abort();let reads=0
 await assert.rejects(()=>collect({[Symbol.asyncIterator](){return{next(){reads++;return new Promise(()=>{})}}}},{signal:before.signal}),/Invalid provider stream/);assert.equal(reads,0)
 const controller=new AbortController();let returned=false,started;const ready=new Promise(r=>started=r)
 const source={[Symbol.asyncIterator](){return{next(){started();return new Promise(()=>{})},return(){returned=true;return Promise.resolve({done:true})}}}}
 const pending=collect(source,{signal:controller.signal});await ready;controller.abort();await assert.rejects(pending,/Invalid provider stream/);assert.equal(returned,true)
})
test('invalid UTF8 is not repaired into different tool arguments',async()=>{
 const source=(async function*(){yield Uint8Array.of(0xc3,0x28)})()
 await assert.rejects(()=>collect(source),/Invalid provider stream/)
})

test('cancellation after a tool candidate suppresses remaining usage',async()=>{
 const controller=new AbortController()
 const text=frame(choice({tool_calls:[{index:0,id:'c',function:{name:'read',arguments:'{}'}}]}))+frame({choices:[],usage:{prompt_tokens:1}})+done
 const iterator=parseOpenAiChatStream(chunks(text),{signal:controller.signal})
 assert.equal((await iterator.next()).value.type,'tool_call');controller.abort()
 await assert.rejects(()=>iterator.next(),/Invalid provider stream/)
})
test('tool IDs and argument budgets cannot be reassigned or silently normalized',async()=>{
 for(const tools of [
  [{index:0,id:'a',function:{name:'read',arguments:'{}'}},{index:0,id:'b',function:{arguments:''}}],
  [{index:0,id:'same',function:{name:'read',arguments:'{}'}},{index:1,id:'same',function:{name:'read',arguments:'{}'}}],
  [{index:0,id:'c',function:{name:'read',arguments:'[]'}}],
 ])await assert.rejects(()=>collect(chunks(frame(choice({tool_calls:tools}))+done)),/Invalid provider stream/)
})

test('cancellation between deltas from one wire frame suppresses remaining output',async()=>{
 const controller=new AbortController()
 const iterator=parseOpenAiChatStream(chunks(frame(choice({content:'first',reasoning:'second'}))+done),{signal:controller.signal})
 assert.equal((await iterator.next()).value.text,'first');controller.abort()
 await assert.rejects(()=>iterator.next(),/Invalid provider stream/)
})

test('a later finish marker cannot override a truncated turn',async()=>{
 const text=frame(choice({tool_calls:[{index:0,id:'c',function:{name:'write',arguments:'{}'}}]}))+frame({choices:[{delta:{},finish_reason:'length'}]})+frame({choices:[{delta:{},finish_reason:'stop'}]})+done
 await assert.rejects(()=>collect(chunks(text)),/Invalid provider stream/)
})
test('tool-name fragments concatenate exactly instead of guessing resends',async()=>{
 const text=frame(choice({tool_calls:[{index:0,id:'c',function:{name:'foo',arguments:'{'}}]}))+frame(choice({tool_calls:[{index:0,function:{name:'foo',arguments:'}'}}]}))+done
 assert.deepEqual(await collect(chunks(text)),[{type:'tool_call',id:'c',name:'foofoo',input:{}}])
})

test('frame byte budget counts CRLF bytes before normalizing line endings',async()=>{
 const comment=':'+ 'x'.repeat(125)
 assert.equal(new TextEncoder().encode(comment+'\r\n\r\n').byteLength,130)
 await assert.rejects(()=>collect(chunks(comment+'\r\n\r\n'+done),{maxFrameBytes:128}),/Invalid provider stream/)
 assert.deepEqual(await collect(chunks(comment+'\n\n'+done),{maxFrameBytes:128}),[])
})

test('source iterator construction errors are redacted like read errors',async()=>{
 await assert.rejects(()=>collect({[Symbol.asyncIterator](){throw Error('private endpoint key')}}),/^Error: Invalid provider stream$/)
})
test('empty continuation IDs preserve the established tool identity',async()=>{
 const part=(id,name,args)=>frame(choice({tool_calls:[{index:0,id,function:{name,arguments:args}}]}))
 const start=part('call_1','read',''),continuation=part('','','{"index":0}')
 assert.deepEqual(await collect(chunks(start+continuation+done)),[{type:'tool_call',id:'call_1',name:'read',input:{index:0}}])
 await assert.rejects(()=>collect(chunks(continuation+start+done)),/Invalid provider stream/)
 await assert.rejects(()=>collect(chunks(start+part('call_2','','{}')+done)),/Invalid provider stream/)
})
