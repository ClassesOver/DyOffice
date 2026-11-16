import test from 'node:test'
import assert from 'node:assert/strict'
import {createAdminProviderPipeline} from '../../server/src/modules/providers/admin-pipeline.ts'
import {createProviderShutdown} from '../../server/src/modules/providers/shutdown.ts'
const input={token:'a',modelId:'model',turnId:'turn',request:{system:'',messages:[],tools:[]}}
function pipeline(work){return createAdminProviderPipeline({transactions:{withPrincipalTransaction:work},keyring:{activeKeyId:'test',keys:{test:Buffer.alloc(32,7)}},profiles:[]})}
test('drain requires permanent disposal; closed pipeline cannot admit work',async()=>{
 const p=pipeline(async()=>{throw Error('unexpected')})
 await assert.rejects(p.drain({timeoutMs:20}))
 p.dispose();await p.drain({timeoutMs:20})
 await assert.rejects(p.turns.run(input,()=>{}));await assert.rejects(p.turns.cancel('a','turn'))
})
for(const stage of ['run','cancel'])test(`drain retains ${stage} orphan until actual dependency settlement`,async()=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
 const p=pipeline(async(_i,fn)=>{entered();await gate;return fn({}, {roles:['config_admin'],deploymentId:'d',userId:'u',sessionId:'s'})})
 const work=stage==='run'?p.turns.run(input,()=>{}):p.turns.cancel('a','turn');await started
 p.dispose();await assert.rejects(work)
 await assert.rejects(p.drain({timeoutMs:20}),/drain/)
 release();await p.drain({timeoutMs:500})
})
test('shutdown orders disposal, drain then pool close and is shared/idempotent',async()=>{
 const events=[];let release;const gate=new Promise(r=>release=r)
 const shutdown=createProviderShutdown({pipeline:{dispose(){events.push('dispose')},async drain(){events.push('drain');await gate}},closeResources:async()=>{events.push('close')}})
 const a=shutdown(),b=shutdown();assert.equal(a,b);assert.deepEqual(events,['dispose','drain'])
 release();await a;await shutdown();assert.deepEqual(events,['dispose','drain','close'])
})
test('failed drain never closes resources or claims shutdown success',async()=>{
 let closed=0
 const shutdown=createProviderShutdown({pipeline:{dispose(){},async drain(){throw Error('drain unavailable')}},closeResources:async()=>{closed++}})
 await assert.rejects(shutdown(),/drain/);await assert.rejects(shutdown(),/drain/);assert.equal(closed,0)
})
