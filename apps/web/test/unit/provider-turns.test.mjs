import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createProviderTurns} from '../../server/src/modules/providers/turns.ts'
const owner={deploymentId:'d',userId:'u',sessionId:'s'}
const request={system:'',messages:[],tools:[]}
const input={token:'a',modelId:'model',turnId:'turn',request}
function setup(overrides={}) {
 const deps={identity:async token=>({...owner,userId:token==='b'?'other':'u'}),authorize:async()=>({identity:owner,revision:'1'}),revalidate:async()=>{},stream:async function*(){yield {type:'delta',text:'hello'}},...overrides}
 return createProviderTurns(deps,{timeoutMs:100,maxActive:2})
}
test('revalidates before dispatch and before every output; never sends request overrides',async()=>{
 let checks=0,dispatch=0;const events=[]
 const service=setup({revalidate:async()=>{checks++},stream:async function*(permit,r){dispatch++;assert.deepEqual(Object.keys(r).sort(),['messages','system','tools']);yield {type:'delta',text:'hello'}}})
 await service.run(input,e=>{events.push(e)})
 assert.equal(dispatch,1);assert.equal(checks,2);assert.deepEqual(events,[{type:'delta',text:'hello'}])
 await assert.rejects(()=>service.run({...input,request:{...request,apiKey:'secret'}},()=>{}),/Invalid/)
 assert.equal(dispatch,1)
})
test('disabled configuration or revoked session never reaches provider',async()=>{
 let dispatch=0
 const service=setup({revalidate:async()=>{throw new Error('private disabled detail')},stream:async function*(){dispatch++}})
 await assert.rejects(()=>service.run(input,()=>{}),/AI turn unavailable/)
 assert.equal(dispatch,0)
})
test('revocation between model events blocks subsequent output and cleans active turn',async()=>{
 let checks=0;const events=[]
 const service=setup({revalidate:async()=>{if(++checks===3)throw new Error('revoked')},stream:async function*(){yield {type:'delta',text:'first'};yield {type:'delta',text:'second'}}})
 await assert.rejects(()=>service.run(input,e=>events.push(e)),/AI turn unavailable/)
 assert.deepEqual(events,[{type:'delta',text:'first'}]);assert.equal(service.activeCount(),0)
})
test('other user cannot cancel, owner cancellation aborts uncooperative provider',async()=>{
 let signal,started;const ready=new Promise(r=>started=r)
 const service=setup({stream:async function*(permit,r,s){signal=s;started();await new Promise(()=>{})}})
 const result=service.run(input,()=>{});await ready
 assert.equal(await service.cancel('b','turn'),false)
 assert.equal(signal.aborted,false)
 assert.equal(await service.cancel('a','turn'),true)
 await assert.rejects(()=>result,/AI turn cancelled/)
 assert.equal(signal.aborted,true);assert.equal(service.activeCount(),1)
})
test('absolute deadline includes stalled authorization and retains capacity for uncooperative work',async()=>{
 const service=createProviderTurns({identity:async()=>owner,authorize:()=>new Promise(()=>{}),revalidate:async()=>{},stream:async function*(){}},{timeoutMs:10,maxActive:1})
 await assert.rejects(()=>service.run(input,()=>{}),/AI turn timed out/)
 assert.equal(service.activeCount(),1)
 await assert.rejects(()=>service.run({...input,turnId:'other'},()=>{}),/capacity/)
})
test('duplicate active turn is rejected rather than executed twice',async()=>{
 let started;const ready=new Promise(r=>started=r)
 const service=setup({stream:async function*(){started();await new Promise(()=>{})}})
 const result=service.run(input,()=>{});await ready
 await assert.rejects(()=>service.run(input,()=>{}),/already active/)
 await service.cancel('a','turn');await assert.rejects(()=>result,/cancelled/)
})

test('permit identity mismatch blocks dispatch and leaks no private errors',async()=>{
 let dispatch=0
 const service=setup({authorize:async()=>({identity:{...owner,userId:'other'},revision:'1'}),stream:async function*(){dispatch++}})
 await assert.rejects(()=>service.run(input,()=>{}),/^Error: AI turn unavailable$/)
 assert.equal(dispatch,0)
})

test('uncooperative work keeps capacity until late completion then releases it',async()=>{
 let finish
 const service=createProviderTurns({identity:async()=>owner,authorize:()=>new Promise(resolve=>{finish=resolve}),revalidate:async()=>{},stream:async function*(){}},{timeoutMs:10,maxActive:1})
 await assert.rejects(()=>service.run(input,()=>{}),/timed out/)
 assert.equal(service.activeCount(),1)
 finish({identity:owner,revision:'1'})
 await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(service.activeCount(),0)
})

test('invalid model event fails closed without exposing adapter metadata',async()=>{
 const events=[]
 const service=setup({stream:async function*(){yield {type:'usage',inputTokens:-1,apiKey:'do-not-emit'}}})
 await assert.rejects(()=>service.run(input,e=>events.push(e)),/AI turn unavailable/)
 assert.deepEqual(events,[])
})

test('cancellation is scoped to deployment and session as well as user',async()=>{
 let started;const ready=new Promise(r=>started=r)
 const service=setup({identity:async token=>token==='other-session'?{...owner,sessionId:'s2'}:owner,stream:async function*(){started();await new Promise(()=>{})}})
 const result=service.run(input,()=>{});await ready
 assert.equal(await service.cancel('other-session','turn'),false)
 await service.cancel('a','turn');await assert.rejects(()=>result,/cancelled/)
})

test('provider exception and oversized events are redacted',async()=>{
 for(const stream of [async function*(){throw new Error('secret endpoint/key')},async function*(){yield {type:'delta',text:'字'.repeat(100000)}}]){
   const events=[]
   await assert.rejects(()=>setup({stream}).run(input,e=>events.push(e)),/^Error: AI turn unavailable$/)
   assert.deepEqual(events,[])
 }
})

test('cumulative output budget rejects many individually small events before over-limit emission',async()=>{
 const events=[]
 let cancelled=false
 const delta={type:'delta',text:'small'}
 const size=new TextEncoder().encode(JSON.stringify(delta)).byteLength
 const deps={identity:async()=>owner,authorize:async()=>({identity:owner,revision:'1'}),revalidate:async()=>{},stream:async function*(p,r,signal){try{yield delta;yield delta;yield delta}finally{cancelled=signal.aborted}}}
 const service=createProviderTurns(deps,{maxOutputBytes:size*2})
 await assert.rejects(()=>service.run(input,e=>events.push(e)),/AI turn output limit exceeded/)
 assert.deepEqual(events,[delta,delta]);assert.equal(cancelled,true)
})

test('cumulative limit counts UTF-8 bytes, accepts exact budget and rejects one byte less',async()=>{
 const delta={type:'delta',text:'你好😀'}
 const size=new TextEncoder().encode(JSON.stringify(delta)).byteLength
 for(const budget of [size,size-1]){
  const events=[]
  const service=createProviderTurns({identity:async()=>owner,authorize:async()=>({identity:owner,revision:'1'}),revalidate:async()=>{},stream:async function*(){yield delta}},{maxOutputBytes:budget})
  if(budget===size){await service.run(input,e=>events.push(e));assert.deepEqual(events,[delta])}
  else{await assert.rejects(()=>service.run(input,e=>events.push(e)),/output limit/);assert.deepEqual(events,[])}
 }
})

test('output budget rejects invalid configuration',()=>{
 for(const maxOutputBytes of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>createProviderTurns({}, {maxOutputBytes}),/Invalid AI turn limits/)
})
