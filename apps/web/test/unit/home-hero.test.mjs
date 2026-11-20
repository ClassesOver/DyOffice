import test from 'node:test'
import assert from 'node:assert/strict'
import {generateHomeHero} from '../../src/shell/home-hero.ts'

const proof='p'.repeat(43),copy={greeting:'下午好，开始新的创作。',guidance:'写份文档，或整理手头的数据。'}
const stream=text=>new Response('event: delta\ndata: '+JSON.stringify({text})+'\n\nevent: done\ndata: {}\n\n',{headers:{'content-type':'text/event-stream'}})
const request=async()=>({entries:[{id:'chat'}],defaultId:'chat'})
test('home hero generates two plain text fields through the configured server model without document tools',async()=>{
 let envelope,headers
 const result=await generateHomeHero({request,csrfToken:proof,language:'zh',hour:14,signal:new AbortController().signal,fetchImpl:async(_url,init)=>{envelope=JSON.parse(init.body);headers=init.headers;return stream(JSON.stringify(copy))}})
 assert.deepEqual(result,copy)
 assert.equal(envelope.modelId,'chat');assert.deepEqual(envelope.request.tools,[])
 assert.match(envelope.request.messages[0].text,/下午|afternoon/)
 assert.equal(headers['x-csrf-token'],proof)
})
test('no configured model means no model request and the caller keeps its fallback',async()=>{
 let calls=0
 assert.equal(await generateHomeHero({request:async()=>({entries:[]}),csrfToken:proof,language:'en',hour:9,signal:new AbortController().signal,fetchImpl:async()=>{calls++;throw Error()}}),null)
 assert.equal(calls,0)
})
for(const [name,text] of [['invalid JSON','hello'],['excessive copy',JSON.stringify({...copy,guidance:'很长'.repeat(100)})],['unexpected shape',JSON.stringify({greeting:copy.greeting})],['multiline field',JSON.stringify({...copy,greeting:'你好\n新的问候'})]])test('home hero rejects '+name,async()=>{
 assert.equal(await generateHomeHero({request,csrfToken:proof,language:'zh',hour:14,signal:new AbortController().signal,fetchImpl:async()=>stream(text)}),null)
})
test('provider errors and canceled or obsolete sessions never replace the fallback',async()=>{
 for(const failure of ['provider','abort','session']){
  const controller=new AbortController();let reads=0
  const result=await generateHomeHero({request:async()=>{if(failure==='session'&&reads++>0)throw Error('stale_session');return {entries:[{id:'chat'}],defaultId:'chat'}},csrfToken:proof,language:'zh',hour:14,signal:controller.signal,fetchImpl:async()=>{if(failure==='provider')throw Error('unavailable');if(failure==='abort')controller.abort();return stream(JSON.stringify(copy))}})
  assert.equal(result,null,failure)
 }
})
test('canceling a live partial stream retains fallback and cancels the upstream turn',async()=>{
 const controller=new AbortController();let canceled=0
 const result=generateHomeHero({request,csrfToken:proof,language:'zh',hour:14,signal:controller.signal,fetchImpl:async(url)=>{
  if(url.endsWith('/cancel')){canceled++;return new Response(null,{status:204})}
  return new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"{\\"greeting\\": "}\n\n'));queueMicrotask(()=>controller.abort())}}),{headers:{'content-type':'text/event-stream'}})
 }})
 assert.equal(await result,null)
 assert.equal(canceled,1)
})
test('a stalled provider times out and cancels its turn while the original copy remains usable',{timeout:10000},async()=>{
 let canceled=0
 const result=await generateHomeHero({request,csrfToken:proof,language:'zh',hour:14,signal:new AbortController().signal,fetchImpl:async url=>{
  if(url.endsWith('/cancel')){canceled++;return new Response(null,{status:204})}
  return new Response(new ReadableStream(),{headers:{'content-type':'text/event-stream'}})
 }})
 assert.equal(result,null);assert.equal(canceled,1)
})
