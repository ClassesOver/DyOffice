import test from 'node:test'
import assert from 'node:assert/strict'
import {summarize,runSamples} from './performance-samples.mjs'
test('nearest-rank percentiles include failed requests, with separate successful latency',()=>{
 const s=summarize([{durationMs:1,status:200,ok:true},{durationMs:10,status:429,ok:false},{durationMs:100,status:0,ok:false}])
 assert.equal(s.attempted,3);assert.equal(s.succeeded,1);assert.equal(s.failed,2);assert.equal(s.all.p95,100);assert.equal(s.successful.p95,1);assert.equal(s.statuses['429'],1)
})
test('empty and invalid samples never yield fabricated zero latency',()=>{
 assert.throws(()=>summarize([]));assert.throws(()=>summarize([{durationMs:NaN,status:200,ok:true}]));assert.throws(()=>summarize([{durationMs:-1,status:200,ok:true}]))
})
test('closed-loop sampler bounds concurrency and retains exact outcomes',async()=>{
 let active=0,peak=0
 const samples=await runSamples({count:13,concurrency:4,request:async i=>{active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return{durationMs:i,status:i===4?500:200,ok:i!==4}}})
 assert.equal(samples.length,13);assert.equal(peak,4);assert.equal(summarize(samples).failed,1)
 await assert.rejects(runSamples({count:0,concurrency:1,request:async()=>{}}))
 await assert.rejects(runSamples({count:10,concurrency:5,request:async()=>{}}))
})
test('thrown failures remain counted and all-failed successful distribution is null',async()=>{
 const samples=await runSamples({count:3,concurrency:2,request:async()=>{throw new Error('private text must not be copied')}})
 const s=summarize(samples);assert.equal(s.failed,3);assert.equal(s.successful,null);assert.equal(s.statuses['0'],3);assert.ok(!JSON.stringify(samples).includes('private text'))
})
test('read workload stays below unchanged global 600-per-minute limiter',async()=>{
 const {BASELINE_WORKLOAD:w}=await import('./performance-samples.mjs')
 const total=w.routeCount*(w.firstPerRoute+w.warmupPerRoute+w.rounds*w.concurrency.length*w.samplesPerRouteRound)
 assert.ok(total<600,`actual planned requests ${total} would exercise the rate limit, not steady-state latency`)
})
