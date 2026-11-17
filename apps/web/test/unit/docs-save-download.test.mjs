import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createDocsBridge} from '../../src/editors/docs-bridge.ts'
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r}),resolve:()=>resolve()}}
function fixture(){
 const initial={fileId:'file',revision:'before',sha256:'a'.repeat(64),size:1},receipt={...initial,revision:'after',sha256:'b'.repeat(64),size:2}
 let state={name:'a.docx',status:'idle',lease:{leaseEpoch:1},revision:initial},dirty=true,saves=0,reconciles=0
 const host={getState:()=>state,save:async()=>{saves++;state={...state,revision:receipt};return {...receipt}},reconcile:async()=>{reconciles++;throw Error('unexpected reconcile')}}
 const bridge=createDocsBridge(host,'file',{language:'en'},()=>{})
 bridge.lifecycle.edited()
 const editor={isDirty:()=>dirty,async save(){await bridge.lifecycle.beforeSave();const result=await bridge.api.saveDocx('/files/file/a.docx',new ArrayBuffer(2));dirty=!result.ok;bridge.lifecycle.afterSave(result.ok);return result.ok}}
 return {bridge,host,editor,receipt,setDirty(value){dirty=value},state:()=>state,counts:()=>({saves,reconciles})}
}
test('save-and-download returns a copy of the exact confirmed current revision',async()=>{
 const f=fixture(),ref=await f.bridge.prepareDownload(f.editor)
 assert.deepEqual(ref,f.receipt);assert.notEqual(ref,f.state().revision);assert.deepEqual(f.counts(),{saves:1,reconciles:0})
})
for(const status of ['unknown','saving','conflict','unauthorized'])test(`download does not save or reconcile from ${status}`,async()=>{
 const f=fixture();f.state().status=status
 await assert.rejects(()=>f.bridge.prepareDownload(f.editor))
 assert.deepEqual(f.counts(),{saves:0,reconciles:0})
})
test('download requires a live editing lease',async()=>{
 const f=fixture();f.state().lease=null
 await assert.rejects(()=>f.bridge.prepareDownload(f.editor));assert.equal(f.counts().saves,0)
})
for(const cause of ['late-edit','incomplete','unknown','lease-loss','head-change','false-save','dispose'])test(`download does not fall back to a saved link after ${cause}`,async()=>{
 const f=fixture(),save=f.editor.save
 f.editor.save=async()=>{
  if(cause==='false-save')return false
  await save()
  if(cause==='late-edit'){f.setDirty(true);f.bridge.lifecycle.edited()}
  if(cause==='incomplete')f.bridge.lifecycle.afterSave(false,['metadata'])
  if(cause==='unknown')f.state().status='unknown'
  if(cause==='lease-loss')f.state().lease=null
  if(cause==='head-change')f.state().revision={...f.receipt,revision:'different'}
  if(cause==='dispose')f.bridge.dispose()
  return true
 }
 await assert.rejects(()=>f.bridge.prepareDownload(f.editor));assert.equal(f.counts().reconciles,0)
})
test('overlapping download requests cannot start a second save',async()=>{
 const f=fixture(),gate=deferred(),save=f.editor.save
 f.editor.save=async()=>{await gate.promise;return save()}
 const pending=f.bridge.prepareDownload(f.editor)
 await assert.rejects(()=>f.bridge.prepareDownload(f.editor));gate.resolve()
 assert.deepEqual(await pending,f.receipt);assert.equal(f.counts().saves,1)
})
test('an unacknowledged serializer cannot reuse an older save receipt',async()=>{
 const f=fixture();await f.bridge.prepareDownload(f.editor)
 f.editor.save=async()=>{await f.bridge.lifecycle.beforeSave();return true}
 await assert.rejects(()=>f.bridge.prepareDownload(f.editor));assert.equal(f.counts().saves,1)
})
test('a queued native save cannot implicitly reconcile when its host becomes unknown',async()=>{
 const f=fixture();const save=f.editor.save
 f.editor.save=async()=>{f.state().status='unknown';return save()}
 await assert.rejects(()=>f.bridge.prepareDownload(f.editor))
 assert.deepEqual(f.counts(),{saves:0,reconciles:0})
})
test('a download queued behind a lost save never takes the automatic reconciliation branch',async()=>{
 const f=fixture(),gate=deferred(),save=f.editor.save
 f.editor.save=async()=>{await gate.promise;return save()}
 const downloading=f.bridge.prepareDownload(f.editor)
 f.host.save=async()=>{f.state().status='unknown';throw Error('lost receipt from earlier save')}
 await f.bridge.lifecycle.beforeSave()
 assert.equal((await f.bridge.api.saveDocx('/files/file/a.docx',new ArrayBuffer(2))).ok,false)
 f.bridge.lifecycle.afterSave(false)
 assert.equal(f.bridge.getState().status,'unknown')
 gate.resolve()
 await assert.rejects(downloading)
 assert.equal(f.counts().reconciles,0)
 assert.equal(f.bridge.getState().status,'unknown')
})
