import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {assistantDiagnostics} from '../helpers/assistant-diagnostics.mjs'
const request=()=>({url:()=> 'https://secret.invalid/api/v1/ai/turns',method:()=> 'POST',postData:()=> 'private document token'})
test('only fixed stages and aggregate same-request states are reported on abort',()=>{
 const c=new AbortController(),out=[],d=assistantDiagnostics(c.signal,x=>out.push(x)),p=new EventEmitter();d.observe(p);d.stage('first-finished');d.arm('first');const a=request(),b=request();p.emit('request',a);p.emit('request',b);p.emit('response',{request:()=>a,status:()=>200});p.emit('requestfinished',b);p.emit('requestfailed',a);p.emit('pageerror',Error('private document token'));c.abort(Error('secret abort'));
 assert.equal(out.length,1);const r=JSON.parse(out[0]);assert.equal(r.stage,'first-finished');assert.deepEqual(r.first,{request:true,response:'2xx',finished:false,failed:true,failureKind:'other'});assert.equal(r.pageErrors,1);assert.doesNotMatch(out[0],/secret|private|invalid|token/);d.report();assert.equal(out.length,1);d.dispose()
})
test('second request is isolated and completion events are exact object matches',()=>{
 const c=new AbortController(),out=[],d=assistantDiagnostics(c.signal,x=>out.push(x)),p=new EventEmitter();d.observe(p);d.arm('first');const a=request();p.emit('request',a);d.arm('second');const b=request();p.emit('request',b);p.emit('requestfinished',a);p.emit('response',{request:()=>b,status:()=>503});d.report();const r=JSON.parse(out[0]);assert.equal(r.first.finished,true);assert.equal(r.second.finished,false);assert.equal(r.second.response,'5xx');d.dispose()
})
test('disposal removes listeners and normal completion emits no report',()=>{
 const c=new AbortController(),out=[],d=assistantDiagnostics(c.signal,x=>out.push(x)),p=new EventEmitter();d.observe(p);d.stage('complete');d.dispose();for(const event of ['request','response','requestfinished','requestfailed','pageerror'])assert.equal(p.listenerCount(event),0);c.abort();assert.deepEqual(out,[])
})
test('invalid diagnostic values reject without echoing their content',()=>{
 const d=assistantDiagnostics(new AbortController().signal,()=>{});assert.throws(()=>d.stage('private content'),/^Error: Invalid diagnostic stage$/);assert.throws(()=>d.arm('private content'),/^Error: Invalid diagnostic turn$/);d.dispose()
})
test('throwing telemetry never masks an original failure or escapes abort',()=>{
 const c=new AbortController(),d=assistantDiagnostics(c.signal,()=>{throw Error('logger failed')}),original=Error('original');let caught
 try{try{throw original}catch(error){d.report();throw error}}catch(error){caught=error}
 assert.equal(caught,original);assert.doesNotThrow(()=>c.abort());d.dispose()
 const other=new AbortController(),abort=assistantDiagnostics(other.signal,()=>{throw Error('logger failed')});assert.doesNotThrow(()=>other.abort());abort.dispose()
})
test('abort after complete does not misreport a successful test',()=>{
 const c=new AbortController(),out=[],d=assistantDiagnostics(c.signal,x=>out.push(x));d.stage('complete');c.abort();assert.deepEqual(out,[]);d.dispose()
})
test('request failure already observed rejects finished wait without treating it as success',async()=>{
 const c=new AbortController(),d=assistantDiagnostics(c.signal,()=>{}),p=new EventEmitter(),a=request();d.observe(p);d.arm('first');p.emit('request',a);p.emit('requestfailed',a)
 await assert.rejects(d.finished({request:()=>a,finished:()=>new Promise(()=>{})}),/^Error: Assistant HTTP request failed$/);d.dispose()
})
test('request failure during finished wait rejects only its exact request and cleans listeners',async()=>{
 const c=new AbortController(),d=assistantDiagnostics(c.signal,()=>{}),p=new EventEmitter(),a=request(),b=request();d.observe(p);d.arm('first');p.emit('request',a)
 let terminal=false;const work=d.finished({request:()=>a,finished:()=>new Promise(()=>{})}).finally(()=>{terminal=true});p.emit('requestfailed',b);await Promise.resolve();assert.equal(terminal,false);p.emit('requestfailed',a);await assert.rejects(work,/Assistant HTTP request failed/);d.dispose();assert.equal(p.listenerCount('requestfailed'),0)
})
test('finished wait preserves original completion error and return value',async()=>{
 const c=new AbortController(),d=assistantDiagnostics(c.signal,()=>{}),p=new EventEmitter(),a=request();d.observe(p);d.arm('first');p.emit('request',a)
 assert.equal(await d.finished({request:()=>a,finished:async()=>null}),null)
 const error=Error('original');await assert.rejects(d.finished({request:()=>a,finished:async()=>{throw error}}),e=>e===error);d.dispose()
})
test('abort and disposal reject outstanding completion waits without a new timeout',async()=>{
 for(const end of ['abort','dispose']){const c=new AbortController(),d=assistantDiagnostics(c.signal,()=>{}),p=new EventEmitter(),a=request();d.observe(p);d.arm('first');p.emit('request',a);const work=d.finished({request:()=>a,finished:()=>new Promise(()=>{})});if(end==='abort')c.abort();else d.dispose();await assert.rejects(work,/Assistant HTTP wait aborted/);d.dispose()}
})
test('failure reason is a fixed enum and never exposes browser error text',()=>{
 const c=new AbortController(),out=[],d=assistantDiagnostics(c.signal,x=>out.push(x)),p=new EventEmitter(),a={...request(),failure:()=>({errorText:'net::ERR_ABORTED'})};d.observe(p);d.arm('first');p.emit('request',a);p.emit('requestfailed',a);d.report();assert.equal(JSON.parse(out[0]).first.failureKind,'aborted');assert.doesNotMatch(out[0],/secret|invalid|net::/);d.dispose()
})
