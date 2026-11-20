import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../server/src/framework.ts'
import {createProviderTurns} from '../server/src/modules/providers/turns.ts'
import {registerProviderRoutes} from '../server/src/modules/providers/routes.ts'
import {createSseAgentTransport} from '../../../packages/browser-host/src/ai-transport.ts'
const token='a'.repeat(43),headers={cookie:'__Host-dyoffice-session='+token,'x-csrf-token':'p'.repeat(43),origin:'https://app.example'}
const request={turnId:'turn',modelId:'model',request:{system:'s',messages:[],tools:[]}}
async function fixture(t,overrides={},options={}) {
 let dispatched=0
 const identity={deploymentId:'d',userId:'u',sessionId:'s'}
 const turns=createProviderTurns({identity:async()=>identity,authorize:async()=>({identity,revision:'1'}),revalidate:async()=>{},stream:async function*(){dispatched++;yield {type:'delta',text:'hello'};yield {type:'tool_call',id:'candidate',name:'read_doc',input:{a:1}};yield {type:'usage',inputTokens:4}},...overrides},{timeoutMs:500})
 const app=await createApiShell()
 registerProviderRoutes(app,{turns,sessions:{authenticate:async supplied=>{if(supplied!==token)throw Object.assign(Error('secret'),{statusCode:401})}},csrf:{requireSession(req){if(req.headers['x-csrf-token']!=='p'.repeat(43)||req.headers.origin!=='https://app.example')throw Object.assign(Error('secret'),{statusCode:403})}},...options})
 await app.ready();t.after(()=>app.close())
 return {app,turns,dispatched:()=>dispatched}
}
test('POST SSE bridges existing callbacks without executing provider tools',async t=>{
 const {app}=await fixture(t);const calls=[]
 const transport=createSseAgentTransport({modelId:'model',getCsrfToken:async()=> 'p'.repeat(43),fetchImpl:async(url,init)=>{
  const r=await app.inject({method:init.method,url,headers:{...headers,...Object.fromEntries(new Headers(init.headers))},payload:init.body});return new Response(r.body,{status:r.statusCode,headers:r.headers})
 }})
 await new Promise(resolve=>transport.stream(request.request,{onDelta:v=>calls.push(['delta',v]),onToolCall:v=>calls.push(['tool',v]),onUsage:v=>calls.push(['usage',v]),onError:v=>calls.push(['error',v]),onDone(){calls.push(['done']);resolve()}}))
 assert.deepEqual(calls.map(v=>v[0]),['delta','tool','usage','done']);assert.deepEqual(calls[1][1],{id:'candidate',name:'read_doc',input:{a:1}})
})
test('cookie and CSRF checks precede dispatch, request routing injection is rejected',async t=>{
 const f=await fixture(t)
 for(const h of [{}, {...headers,'x-csrf-token':'wrong'}, {...headers,authorization:'Bearer attacker'}]){
  const r=await f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers:h,payload:request});assert.ok([401,403].includes(r.statusCode));assert.equal(r.body.includes('secret'),false)
 }
 for(const payload of [{...request,baseUrl:'https://evil.example'},{...request,request:{...request.request,apiKey:'secret'}},{...request,modelId:''}]){
  assert.equal((await f.app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload})).statusCode,400)
 }
 assert.equal(f.dispatched(),0)
})
test('disabled permit, provider failure and output quota end with one redacted error/done',async t=>{
 for(const [deps,options] of [[{authorize:async()=>{throw Error('private key')}},{}],[{stream:async function*(){throw Error('private key')}},{}],[{stream:async function*(){yield {type:'delta',text:'x'.repeat(500)}}},{maxOutputBytes:128}]]){
  const {app}=await fixture(t,deps,options);const r=await app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload:request})
  assert.equal(r.statusCode,200);assert.equal(r.headers['content-type'],'text/event-stream; charset=utf-8');assert.match(r.headers['cache-control'],/no-store/)
  assert.equal((r.body.match(/event: error/g)||[]).length,1);assert.equal((r.body.match(/event: done/g)||[]).length,1);assert.equal(r.body.includes('private key'),false)
 }
})
test('Office reports the turn deadline after partial text without redispatching the model',async t=>{
 let attempts=0
 const {app}=await fixture(t,{stream:async function*(_permit,_request,signal){
  attempts++
  yield {type:'delta',text:'partial reply'}
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
  throw Error('private upstream detail')
 }})
 const r=await app.inject({method:'POST',url:'/api/v1/ai/turns',headers,payload:request})
 assert.equal(r.statusCode,200)
 const frames=r.body.trim().split('\n\n').map(frame=>{
  const [event,data]=frame.split('\n')
  return [event.slice(7),JSON.parse(data.slice(6))]
 })
 assert.deepEqual(frames.map(([event])=>event),['delta','error','done'])
 assert.equal(frames[0][1].text,'partial reply')
 assert.equal(frames[1][1].reason,'AI_TURN_TIMED_OUT')
 assert.match(frames[1][1].message,/timed out/i)
 assert.doesNotMatch(r.body,/private upstream detail/)
 assert.equal(attempts,1)
})
test('cancel route rejects request bodies and cannot bypass CSRF',async t=>{
 const {app}=await fixture(t)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/turns/turn/cancel',headers,payload:{}})).statusCode,400)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/turns/turn/cancel',headers:{cookie:headers.cookie}})).statusCode,403)
 assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/turns/turn/cancel',headers})).statusCode,204)
})

test('real HTTP disconnect during authorization aborts without dispatch or releasing orphan capacity',async t=>{
 let release,entered;const started=new Promise(r=>entered=r)
 const identity={deploymentId:'d',userId:'u',sessionId:'s'}
 const f=await fixture(t,{authorize:()=>{entered();return new Promise(r=>release=r)}})
 const address=await f.app.listen({host:'127.0.0.1',port:0})
 const {request:send}=await import('node:http')
 const req=send(address+'/api/v1/ai/turns',{method:'POST',headers:{...headers,'content-type':'application/json'}})
 req.on('error',()=>{});req.end(JSON.stringify(request));await started;req.destroy()
 await new Promise(r=>setTimeout(r,20));assert.equal(f.turns.activeCount(),1)
 release({identity,revision:'1'});await new Promise(r=>setTimeout(r,20))
 assert.equal(f.dispatched(),0);assert.equal(f.turns.activeCount(),0)
})

test('terminal frames never wait indefinitely for a non-reading client',async()=>{
 const {EventEmitter}=await import('node:events');const response=new EventEmitter()
 const writes=[];Object.assign(response,{destroyed:false,writableEnded:false,setHeader(){},write(frame){writes.push(frame);return false},end(){this.writableEnded=true}})
 let handler
 const api={addHook(){},post(path,options,fn){if(path==='/api/v1/ai/turns')handler=fn}}
 registerProviderRoutes({register:fn=>fn(api)},{sessions:{},csrf:{},turns:{run:async()=>{},cancel:async()=>false}})
 const pending=handler({body:request,raw:{rawHeaders:[]},headers:{cookie:headers.cookie}},{raw:response,hijack(){}})
 assert.equal(await Promise.race([pending.then(()=>true),new Promise(r=>setTimeout(()=>r(false),30))]),true)
 assert.equal(response.writableEnded,true);assert.equal(writes.filter(x=>x.includes('event: done')).length,1)
 response.emit('close')
})
