import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdminAiProbeController } from '../../../../packages/browser-host/src/ai-probe.ts'
const tick = () => new Promise(r => setTimeout(r, 15))
const event = (name,data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
const sse = text => new Response(text, { headers:{'content-type':'text/event-stream'} })
const record = () => { const calls=[]; return {calls, callbacks:{onDelta:x=>calls.push(['delta',x]),onError:x=>calls.push(['error',x]),onDone:()=>calls.push(['done'])}} }
const base={getCsrfToken:async()=> 'a'.repeat(43),createTurnId:()=> 'turn-1'}
test('explicit run sends only fixed scenario, same origin and CSRF', async()=>{
 const requests=[]; const c=createAdminAiProbeController({...base,fetchImpl:async(url,init)=>{requests.push({url,init});return sse(event('delta',{text:'Hi'})+event('done',{}))}})
 assert.equal(requests.length,0); const r=record(); c.run('model1',r.callbacks); await tick()
 assert.deepEqual(JSON.parse(requests[0].init.body),{modelId:'model1',turnId:'turn-1',scenario:'hello'})
 assert.equal(requests[0].url,'/api/v1/admin/ai-probe/turns'); assert.equal(requests[0].init.headers['x-csrf-token'],'a'.repeat(43)); assert.equal(requests[0].init.mode,'same-origin');assert.equal(requests[0].init.redirect,'error')
 assert.deepEqual(r.calls,[['delta','Hi'],['done']]);c.dispose()
})
test('cancel during late CSRF prevents dispatch and terminates once',async()=>{
 let resolve;let sent=0; const c=createAdminAiProbeController({...base,getCsrfToken:()=>new Promise(r=>resolve=r),fetchImpl:async()=>{sent++;return sse('')}});const r=record();c.run('m',r.callbacks);assert.throws(()=>c.run('m',r.callbacks));c.cancel();c.cancel();resolve('a'.repeat(43));await tick();assert.equal(sent,0);assert.deepEqual(r.calls,[['done']]);c.dispose();assert.throws(()=>c.run('m',r.callbacks))
})
test('tool event is rejected, no following delta delivered',async()=>{
 const c=createAdminAiProbeController({...base,fetchImpl:async()=>sse(event('tool_call',{id:'1',name:'write',input:{}})+event('delta',{text:'bad'})+event('done',{}))});const r=record();c.run('m',r.callbacks);await tick();assert.deepEqual(r.calls.map(x=>x[0]),['error','done']);c.dispose()
})
test('dispose after dispatch cancels only once and suppresses late response',async()=>{
 const urls=[];let response;const c=createAdminAiProbeController({...base,fetchImpl:async(url)=>{urls.push(url);if(url.endsWith('/cancel'))return new Response(null,{status:204});return new Promise(r=>response=r)}});const r=record();c.run('m',r.callbacks);await tick();c.dispose();c.dispose();response(sse(event('delta',{text:'late'})+event('done',{})));await tick();assert.deepEqual(r.calls,[['done']]);assert.deepEqual(urls,['/api/v1/admin/ai-probe/turns','/api/v1/admin/ai-probe/turns/turn-1/cancel'])
})
test('status exposes only safe allowlisted fields and rejects after dispose',async()=>{
 const c=createAdminAiProbeController({...base,fetchImpl:async()=>Response.json({experimental:true,entries:[{id:'m',label:'Test'}]})});assert.deepEqual(await c.status(),{experimental:true,entries:[{id:'m',label:'Test'}]});c.dispose();await assert.rejects(c.status())
})
test('invalid model and turn identifiers fail before network',()=>{
 const c=createAdminAiProbeController({...base,createTurnId:()=> '../escape',fetchImpl:async()=>{throw Error('must not send')}});assert.throws(()=>c.run('m',record().callbacks));assert.throws(()=>c.run('https://bad',record().callbacks));c.dispose()
})
test('status rejects leaked fields and delayed body after dispose',async()=>{
 const c=createAdminAiProbeController({...base,fetchImpl:async()=>Response.json({experimental:true,entries:[],secret:'no'})});await assert.rejects(c.status());c.dispose()
 let release;const d=createAdminAiProbeController({...base,fetchImpl:async()=>new Response(new ReadableStream({start(controller){release=text=>{try{controller.enqueue(new TextEncoder().encode(text));controller.close()}catch{}}}}),{headers:{'content-type':'application/json'}})});const pending=d.status();await tick();d.dispose();release(JSON.stringify({experimental:true,entries:[]}));await assert.rejects(pending)
})
test('bad CSRF is sanitized and never dispatches; callback failure still finishes',async()=>{
 let sent=0;const c=createAdminAiProbeController({...base,getCsrfToken:async()=>{throw Error('private-secret')},fetchImpl:async()=>{sent++;return sse('')}});const r=record();c.run('m',r.callbacks);await tick();assert.equal(sent,0);assert.deepEqual(r.calls,[['error','Probe failed'],['done']]);c.dispose()
 const d=createAdminAiProbeController({...base,fetchImpl:async()=>sse(event('delta',{text:'x'})+event('done',{}))});let done=0;d.run('m',{onDelta(){throw Error('observer')},onError(){throw Error('observer')},onDone(){done++}});await tick();assert.equal(done,1);d.dispose()
})
for (const [name,data] of [['unexpected',{}],['delta',{text:42}],['done',{secret:'bad'}]]) test(`strict probe rejects ${name} bad shape`,async()=>{
 const c=createAdminAiProbeController({...base,fetchImpl:async()=>sse(event(name,data)+event('done',{}))});const r=record();c.run('m',r.callbacks);await tick();assert.deepEqual(r.calls.map(x=>x[0]),['error','done']);c.dispose()
})
test('status caps streamed bytes before reading complete response',async()=>{
 let reads=0,cancelled=0;const chunk=new TextEncoder().encode(' '.repeat(32769));const c=createAdminAiProbeController({...base,fetchImpl:async()=>new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(chunk);if(reads===100)controller.close()},cancel(){cancelled++}},{highWaterMark:0}),{headers:{'content-type':'application/json'}})});await assert.rejects(c.status());assert.ok(reads<=3,`read ${reads} chunks`);assert.equal(cancelled,1);c.dispose()
})
test('status rejects malformed UTF8 instead of replacement decoding',async()=>{
 const bytes=Buffer.concat([Buffer.from('{"experimental":true,"entries":[{"id":"m","label":"'),Buffer.from([0xff]),Buffer.from('"}]}')]);const c=createAdminAiProbeController({...base,fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'application/json'}})});await assert.rejects(c.status());c.dispose()
})
test('unsupported dotted model entry fails before network',()=>{
 let sent=0;const client=createAdminAiProbeController({getCsrfToken:async()=>'a'.repeat(43),fetchImpl:async()=>{sent++;throw Error('network forbidden')}})
 assert.throws(()=>client.run('model.v1',{onDelta(){},onError(){},onDone(){}}),/model identifier/);assert.equal(sent,0);client.dispose()
})
