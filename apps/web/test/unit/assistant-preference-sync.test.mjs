import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter,once} from 'node:events'
import {createAssistantPreferenceSync} from '../../src/editors/assistant-preference-sync.ts'

test('assistant preference notifications reread only the matching account and cannot replace a newer local save',{timeout:4000},async t=>{
 const account=['deployment','account']
 const events=new EventEmitter()
 let pending, reads=0, otherReads=0
 const receiver=createAssistantPreferenceSync(account,()=>{
  if(++reads===1)return new Promise(resolve=>{pending=resolve;events.emit('reading')})
  return Promise.resolve('latest server')
 },value=>events.emit('applied',value))
 const sender=createAssistantPreferenceSync(account,async()=>'',()=>{})
 const other=createAssistantPreferenceSync(['deployment','other'],async()=>{otherReads++;return ''},()=>{})
 t.after(()=>{receiver.close();sender.close();other.close()})
 const reading=once(events,'reading')
 sender.saved()
 await reading
 receiver.saved()
 const applied=once(events,'applied')
 pending('older server')
 assert.deepEqual(await applied,['latest server'])
 assert.equal(reads,2)
 assert.equal(otherReads,0)
})

test('closing a preference subscription discards an outstanding read',async()=>{
 let complete
 const updates=[]
 const sync=createAssistantPreferenceSync(['deployment','closing-account'],()=>new Promise(resolve=>{complete=resolve}),value=>updates.push(value))
 const refresh=sync.refresh()
 sync.close()
 complete('previous account')
 await refresh
 assert.deepEqual(updates,[])
})
