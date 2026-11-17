import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHarnessRegistry} from '../../server/src/modules/coding/registry.ts'

const adapter=(id,origin='external')=>({descriptor:{id,name:id,origin,capabilities:['coding']},run:async input=>({summary:id,output:input.instruction})})
test('builtin and external use identical selection and invocation',async()=>{
 const registry=createHarnessRegistry([adapter('codex','builtin'),adapter('remote')],'codex')
 assert.deepEqual(registry.list().map(x=>x.id),['codex','remote'])
 assert.equal((await registry.run('owner',{instruction:'code'},new AbortController().signal)).summary,'codex')
 assert.equal((await registry.run('owner',{instruction:'code',agentId:'remote'},new AbortController().signal)).summary,'remote')
 await assert.rejects(registry.run('owner',{instruction:'code',agentId:'unknown'},new AbortController().signal),/unavailable/)
})
test('caps coding work separately and releases capacity after failure',async()=>{
 let finish
 const registry=createHarnessRegistry([{descriptor:adapter('codex').descriptor,run:()=>new Promise(resolve=>{finish=resolve})}],'codex')
 const pending=registry.run('alice',{instruction:'code'},new AbortController().signal)
 await assert.rejects(registry.run('alice',{instruction:'second'},new AbortController().signal),/busy/)
 finish({summary:'ok',output:''});await pending
 assert.equal((await registry.run('bob',{instruction:'next',agentId:'bad'},new AbortController().signal).catch(e=>e)).message,'Coding agent unavailable')
})
test('adapter failures do not prevent another peer from working',async()=>{
 const broken={...adapter('broken'),run:async()=>{throw Error('offline')}}
 const registry=createHarnessRegistry([broken,adapter('working')],'broken')
 await assert.rejects(registry.run('alice',{instruction:'code'},new AbortController().signal),/offline/)
 assert.equal((await registry.run('alice',{instruction:'code',agentId:'working'},new AbortController().signal)).summary,'working')
})
