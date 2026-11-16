import test from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import https from 'node:https'
import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import {createHash} from 'node:crypto'
import {createPinnedProviderTransport} from '../../server/src/modules/providers/pinned-egress.ts'
const body=Buffer.from('{"model":"synthetic","stream":true}')
const profile={deploymentId:'dep',entryId:'entry',revision:1,providerId:'openai',model:'synthetic',baseUrl:'https://provider.example/v1',endpoint:'https://provider.example/v1/chat/completions',allowedIpv4:['8.8.8.8']}
const scope=()=>({...profile,credential:Buffer.from('synthetic-key'),requestDigest:createHash('sha256').update(body).digest('hex'),turnId:'turn',reservationId:'reservation',claimId:'claim',signal:new AbortController().signal})
function network(t,{addresses=[{address:'8.8.8.8',family:4}],status=200,headers={'content-type':'text/event-stream'},chunks=[Buffer.from('data: test\n\n')],peer='8.8.8.8',authorized=true,port=443,finishGate}={}){
 let options,written,requests=0,flushes=0;const sockets=[]
 t.mock.method(dns,'lookup',async()=>addresses)
 t.mock.method(https,'request',(url,opts,cb)=>{
  requests++;options=opts
  const req=new EventEmitter()
  req.destroy=e=>{queueMicrotask(()=>req.emit('error',e??Error('closed')));return req}
  req.flushHeaders=()=>{flushes++}
  req.end=b=>{written=Buffer.from(b);const res=Readable.from(chunks);res.statusCode=status;res.headers=headers;queueMicrotask(()=>{if(!finishGate)req.emit('finish');cb(res)});if(finishGate)finishGate.then(()=>req.emit('finish'));return req}
  const socket=new EventEmitter();Object.assign(socket,{authorized,remoteAddress:peer,remotePort:port});sockets.push(socket)
  queueMicrotask(()=>{req.emit('socket',socket);socket.emit('secureConnect')})
  return req
 })
 return {get options(){return options},get written(){return written},get requests(){return requests},get flushes(){return flushes},sockets}
}
test('pins lookup and authenticated TLS peer before exact hashed body is sent',async t=>{
 const n=network(t),received=[];const tr=createPinnedProviderTransport({profiles:[profile]})
 await tr.send(scope(),body,b=>{received.push(b.toString())})
 assert.deepEqual(n.written,body);assert.deepEqual(received,['data: test\n\n'])
 assert.equal(n.options.rejectUnauthorized,true);assert.equal(n.options.servername,'provider.example')
 assert.equal(n.options.agent,false);assert.equal(n.options.family,4);assert.equal(n.options.autoSelectFamily,false);assert.equal(n.options.checkServerIdentity,undefined);assert.equal(n.flushes,0)
 const lookup=await new Promise((resolve,reject)=>n.options.lookup('provider.example',{},(e,a,f)=>e?reject(e):resolve([a,f])))
 assert.deepEqual(lookup,['8.8.8.8',4]);assert.equal(tr.activeCount(),0)
})
for(const address of ['127.0.0.1','169.254.169.254','100.100.100.200','192.0.2.1','198.18.0.1','203.0.113.1','224.1.1.1','::ffff:8.8.8.8','2001:4860:4860::8888'])test('rejects unsafe DNS address '+address,async t=>{
 const n=network(t,{addresses:[{address,family:address.includes(':')?6:4}]})
 await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send(scope(),body,()=>{}),{message:'Provider transport unavailable'});assert.equal(n.requests,0)
})
for(const status of [301,302,307,308,401,500])test('rejects status '+status+' without redirect or retry',async t=>{
 const n=network(t,{status});await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send(scope(),body,()=>{}));assert.equal(n.requests,1)
})
test('wrong digest rejects before DNS and request',async t=>{
 const n=network(t);await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send({...scope(),requestDigest:'0'.repeat(64)},body,()=>{}));assert.equal(n.requests,0)
})
for(const bad of [{peer:'8.8.4.4'},{authorized:false},{port:444}])test('rejects TLS peer before body '+JSON.stringify(bad),async t=>{
 const n=network(t,bad);await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send(scope(),body,()=>{}));assert.equal(n.written,undefined)
})
for(const headers of [{'content-type':'text/event-stream-evil'},{'content-type':'text/event-stream','content-encoding':'gzip'}])test('rejects response headers '+JSON.stringify(headers),async t=>{
 network(t,{headers});let calls=0;await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send(scope(),body,()=>{calls++}));assert.equal(calls,0)
})
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const tick=()=>new Promise(r=>setImmediate(r))
test('does not accept early successful response before request bytes finish flushing',async t=>{
 const gate=deferred();network(t,{finishGate:gate.promise})
 let done=false;const work=createPinnedProviderTransport({profiles:[profile]}).send(scope(),body,()=>{}).then(()=>{done=true})
 await tick();assert.equal(done,false);gate.resolve();await work
})
test('body/profile snapshots resist mutation during DNS and lookup cannot rebind',async t=>{
 const n=network(t),dnsGate=deferred()
 t.mock.method(dns,'lookup',()=>dnsGate.promise)
 const p={...profile,allowedIpv4:[...profile.allowedIpv4]},input=Buffer.from(body)
 const tr=createPinnedProviderTransport({profiles:[p]}),work=tr.send(scope(),input,()=>{})
 input.fill(0);p.endpoint='https://evil.example/';p.allowedIpv4[0]='127.0.0.1'
 dnsGate.resolve([{address:'8.8.8.8',family:4}]);await work;assert.deepEqual(n.written,body)
 await new Promise(r=>n.options.lookup('evil.example',{},e=>{assert.ok(e);r()}))
 assert.deepEqual(await new Promise(r=>n.options.lookup('provider.example',{all:true},(e,a)=>r(a))),[{address:'8.8.8.8',family:4}])
})
test('mixed public/private and unlisted public DNS answers fail before request',async t=>{
 const n=network(t,{addresses:[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]})
 await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send(scope(),body,()=>{}));assert.equal(n.requests,0)
})
test('canceled pending DNS retains slot until DNS actually settles and never dispatches',async t=>{
 const n=network(t),gate=deferred();t.mock.method(dns,'lookup',()=>gate.promise)
 const tr=createPinnedProviderTransport({profiles:[profile],maxConcurrent:1}),c=new AbortController()
 const run=tr.send({...scope(),signal:c.signal},body,()=>{});await tick();c.abort()
 await assert.rejects(run);assert.equal(tr.activeCount(),1)
 await assert.rejects(tr.send(scope(),body,()=>{}));assert.equal(n.requests,0)
 gate.resolve([{address:'8.8.8.8',family:4}]);await tick();assert.equal(tr.activeCount(),0);assert.equal(n.requests,0)
})
test('total timeout covers DNS and does not release unresolved capacity',async t=>{
 const n=network(t),gate=deferred();t.mock.method(dns,'lookup',()=>gate.promise)
 const tr=createPinnedProviderTransport({profiles:[profile],timeoutMs:10})
 await assert.rejects(tr.send(scope(),body,()=>{}));assert.equal(tr.activeCount(),1)
 gate.resolve([{address:'8.8.8.8',family:4}]);await tick();assert.equal(tr.activeCount(),0);assert.equal(n.requests,0)
})
test('response byte limit rejects before delivering excess',async t=>{
 network(t,{chunks:[Buffer.from('abcd')]});let calls=0
 await assert.rejects(createPinnedProviderTransport({profiles:[profile],maxResponseBytes:3}).send(scope(),body,()=>{calls++}));assert.equal(calls,0)
})
test('aborted downstream callback keeps capacity and starts no later callbacks',async t=>{
 network(t,{chunks:[Buffer.from('a'),Buffer.from('b')]})
 const gate=deferred(),started=deferred(),c=new AbortController(),tr=createPinnedProviderTransport({profiles:[profile]});let calls=0
 const work=tr.send({...scope(),signal:c.signal},body,async()=>{calls++;started.resolve();await gate.promise})
 await started.promise;c.abort();await assert.rejects(work);assert.equal(tr.activeCount(),1);assert.equal(calls,1)
 gate.resolve();await tick();assert.equal(tr.activeCount(),0);assert.equal(calls,1)
})
test('credential header injection rejects before network',async t=>{
 const n=network(t);await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send({...scope(),credential:Buffer.from('key\r\nX: secret')},body,()=>{}));assert.equal(n.requests,0)
})
test('missing dispatch identity and hostile signal access fail generically before DNS',async t=>{
 const n=network(t)
 await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send({...scope(),claimId:undefined},body,()=>{}),{message:'Provider transport unavailable'})
 const hostile=scope();Object.defineProperty(hostile,'signal',{get(){throw Error('private-key')}})
 await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send(hostile,body,()=>{}),{message:'Provider transport unavailable'})
 assert.equal(n.requests,0)
})
test('invalid signal cannot inject an error during finally cleanup',async t=>{
 const n=network(t),signal={removeEventListener(){throw Error('private-key')}}
 await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send({...scope(),signal},body,()=>{}),{message:'Provider transport unavailable'})
 assert.equal(n.requests,0)
})
for(const text of ['{"model":"other","stream":true}','{"model":"synthetic","stream":false}','{"model":"other","model":"synthetic","stream":true}','{ "model":"synthetic","stream":true}'])test('rejects noncanonical or mismatched model/stream body '+text,async t=>{
 const n=network(t),wire=Buffer.from(text),s={...scope(),requestDigest:createHash('sha256').update(wire).digest('hex')}
 await assert.rejects(createPinnedProviderTransport({profiles:[profile]}).send(s,wire,()=>{}),{message:'Provider transport unavailable'})
 assert.equal(n.requests,0)
})
