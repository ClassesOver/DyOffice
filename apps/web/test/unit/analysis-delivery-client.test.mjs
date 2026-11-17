import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createAnalysisDeliveryClient} from '../../../../packages/browser-host/src/analysis-delivery-client.ts'
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const bytes=new TextEncoder().encode('<script>never render</script>'),hash=createHash('sha256').update(bytes).digest('hex')
const proof='p'.repeat(43),agent={id:'codex',name:'<img src=x>',origin:'builtin'}
const receipt=()=>({taskId:id(1),claimId:id(2),connectionEpoch:1,commandId:id(3),summary:'<script>untrusted report</script>',artifacts:[{taskId:id(1),artifactId:id(4),name:'report.html',mediaType:'text/html',role:'report',sizeBytes:bytes.length,sha256:hash,inputResultIds:[id(5)]}],inputs:[{resultId:id(5),sourceId:'metrics',sourceVersion:2,queryHash:'b'.repeat(64),sha256:'c'.repeat(64),rowCount:3,truncated:true}],runtimeManifestSha256:'a'.repeat(64),limitations:['Partial input'],createdAt:'2026-11-17T00:00:00Z'})
const hint={taskId:id(1),commandId:id(3),summary:'forged adapter summary',url:'https://attacker.invalid'}
function make(overrides={}){let calls=[];const value=receipt();const client=createAnalysisDeliveryClient({request:async path=>{calls.push(path);return value},csrfToken:proof,fetchImpl:async(path,init)=>{calls.push({path,init});return new Response(bytes,{headers:{'content-type':'application/octet-stream','x-content-sha256':hash}})},...overrides});return {client,value,calls}}
test('only owner receipt is displayed; adapter content is ignored; snapshot cannot mutate trusted state',async()=>{
 const f=make();await f.client.observe(hint,agent)
 const shown=f.client.snapshot();assert.equal(shown.length,1);assert.equal(shown[0].receipt.summary,receipt().summary);assert.equal(shown[0].receipt.inputs[0].truncated,true)
 shown[0].receipt.summary='tampered';assert.equal(f.client.snapshot()[0].receipt.summary,receipt().summary)
 assert.deepEqual(f.calls,['/api/v1/agents/deliveries/'+id(3)]);f.client.dispose()
})
test('wrong task, forged file route and oversized artifact fail closed',async()=>{
 for(const mutate of [r=>r.taskId=id(9),r=>r.artifacts[0].artifactId='https://evil.test/x',r=>r.artifacts[0].sizeBytes=8*1024*1024+1,r=>r.inputs[0].rows=[{secret:1}]]){
  const f=make();mutate(f.value);await f.client.observe(hint,agent);assert.deepEqual(f.client.snapshot(),[]);assert.ok(f.client.error());f.client.dispose()
 }
 const f=make();await f.client.observe({...hint,commandId:'../other'},agent);assert.equal(f.calls.length,0);f.client.dispose()
})
test('stale disposed receipt completion cannot repopulate presentation',async()=>{
 let release;const client=createAnalysisDeliveryClient({request:()=>new Promise(r=>release=r),csrfToken:proof});const p=client.observe(hint,agent);client.dispose();release(receipt());await p;assert.deepEqual(client.snapshot(),[])
})
test('download is explicit, reauthorizes with bound session, checks hash and forces inert bytes',async()=>{
 const f=make();await f.client.observe(hint,agent);assert.equal(f.calls.length,1)
 const file=await f.client.download(id(3),id(4));assert.equal(file.name,'report.html');assert.deepEqual(file.bytes,bytes)
 const request=f.calls.find(x=>typeof x==='object');assert.equal(request.path,'/api/v1/agents/artifacts/'+id(4)+'/content');assert.equal(request.init.headers['X-CSRF-Token'],proof);assert.equal(request.init.redirect,'error');assert.equal(request.init.credentials,'same-origin');assert.equal(f.calls.filter(x=>typeof x==='string').length,3);f.client.dispose()
})
test('denied session recheck clears receipts before binary transfer',async()=>{
 let count=0,binary=0;const f=make({request:async()=>{if(++count>1)throw Error('private session diagnostics');return receipt()},fetchImpl:async()=>{binary++;return new Response(bytes)}});await f.client.observe(hint,agent);await assert.rejects(f.client.download(id(3),id(4)));assert.equal(binary,0);assert.deepEqual(f.client.snapshot(),[]);assert.doesNotMatch(f.client.error(),/private/);f.client.dispose()
})
test('corrupt, oversized and redirected binary responses are never offered',async()=>{
 for(const response of [()=>new Response('wrong',{headers:{'content-type':'application/octet-stream','x-content-sha256':hash}}),()=>new Response(bytes,{headers:{'content-type':'application/octet-stream','x-content-sha256':hash,'content-length':String(9*1024*1024)}}),()=>{const r=new Response(bytes,{headers:{'content-type':'application/octet-stream','x-content-sha256':hash}});Object.defineProperty(r,'redirected',{value:true});return r}]){
  const f=make({fetchImpl:async()=>response()});await f.client.observe(hint,agent);await assert.rejects(f.client.download(id(3),id(4)));f.client.dispose()
 }
})
test('session changes while bytes arrive reject download and clear displayed metadata',async()=>{
 let reads=0;const f=make({request:async()=>{if(++reads===3)throw Error('session changed');return receipt()}});await f.client.observe(hint,agent);await assert.rejects(f.client.download(id(3),id(4)));assert.deepEqual(f.client.snapshot(),[]);f.client.dispose()
})

test('late checksum completion after disposal cannot return downloadable bytes',async t=>{
 let release,started;const ready=new Promise(r=>started=r),real=crypto.subtle.digest.bind(crypto.subtle)
 t.mock.method(crypto.subtle,'digest',async(...args)=>{const result=await real(...args);started();return new Promise(resolve=>release=()=>resolve(result))})
 const f=make();await f.client.observe(hint,agent);const pending=f.client.download(id(3),id(4));await ready;f.client.dispose();release();await assert.rejects(pending);assert.deepEqual(f.client.snapshot(),[])
})

test('disposal publishes empty metadata to a still-mounted subscriber',async()=>{
 const f=make();await f.client.observe(hint,agent);let last=f.client.snapshot()
 f.client.subscribe(()=>last=f.client.snapshot());f.client.dispose();assert.deepEqual(last,[])
})
test('presentation revalidation clears text when current owner authorization is lost',async()=>{
 let allowed=true;const f=make({request:async()=>{if(!allowed)throw Error('revoked');return receipt()}})
 await f.client.observe(hint,agent);assert.equal(f.client.snapshot().length,1);allowed=false;await f.client.refresh();assert.deepEqual(f.client.snapshot(),[]);f.client.dispose()
})
