import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createSessionFileHost} from '../../../../packages/browser-host/src/session-files.ts'

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
function barrier(){let enter,release;return {entered:new Promise(r=>{enter=r}),gate:new Promise(r=>{release=r}),enter:()=>enter(),release:()=>release()}}
function fixture(t,intercept=()=>undefined,options={}){
 const fileId=randomUUID(),editorId=randomUUID(),revision={fileId,revision:randomUUID(),sha256:'a'.repeat(64),size:10}
 let epoch=1
 const lease=()=>({leaseEpoch:epoch,editorId,expiresAt:new Date(Date.now()+60000).toISOString()})
 const fetchImpl=async(path,init={})=>{
  const handled=await intercept(path,init,{lease,revision,setEpoch:value=>{epoch=value}})
  if(handled)return handled
  if(path.endsWith('/csrf'))return json({csrfToken:'a'.repeat(43)})
  if(path.endsWith('/lease')&&init.method==='DELETE')return new Response(null,{status:204})
  if(path.endsWith('/lease')&&!init.method)return json({...lease(),active:true})
  if(path.includes('/lease'))return json(lease())
  if(path===`/api/v1/files/${fileId}`)return json({file:revision,format:'xlsx',name:'test.xlsx',capabilities:{docx:'editable',xlsx:'editable',pptx:'read_only',pdf:'read_only'},downloadEndpoint:`/api/v1/files/${fileId}/content?revision=${revision.revision}`})
  throw new Error(`Unexpected fetch ${path}`)
 }
 const host=createSessionFileHost({fetchImpl,editorId,leaseRetryDelayMs:0,...options});t.after(()=>host.dispose())
 return {host,fileId,revision,lease}
}

test('refresh acquire retries a release race finitely without taking over',async t=>{
 const gate=barrier();let acquires=0,takeovers=0
 const f=fixture(t,async(path,init)=>{
  if(path.endsWith('/takeover'))takeovers++
  if(path.endsWith('/lease')&&init.method==='POST'){
   acquires++;if(acquires===1){gate.enter();await gate.gate;return json({},409)}
  }
 })
 await f.host.open(f.fileId)
 const acquiring=f.host.acquireLease(f.fileId);await gate.entered;gate.release()
 await acquiring
 assert.equal(acquires,2);assert.equal(takeovers,0);assert.ok(f.host.getState(f.fileId).lease)
})

test('contended acquire stops after three attempts',async t=>{
 let attempts=0
 const f=fixture(t,(path,init)=>{if(path.endsWith('/lease')&&init.method==='POST'){attempts++;return json({},409)}})
 await f.host.open(f.fileId)
 await assert.rejects(f.host.acquireLease(f.fileId),{code:'CONFLICT'})
 assert.equal(attempts,3)
})

test('renewal during release cannot resurrect the released lease',async t=>{
 const gate=barrier();let renewals=0
 const f=fixture(t,async(path,init)=>{
  if(path.endsWith('/lease')&&init.method==='DELETE'){gate.enter();await gate.gate}
  if(path.endsWith('/renew'))renewals++
 })
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const releasing=f.host.releaseLease(f.fileId);await gate.entered
 assert.equal(f.host.getState(f.fileId).lease,null)
 await assert.rejects(f.host.renewLease(f.fileId),{code:'CONFLICT'})
 gate.release();await releasing
 assert.equal(renewals,0);assert.equal(f.host.getState(f.fileId).lease,null)
})

test('overlapping renew calls share one fetch and cannot race a valid reply against failure',async t=>{
 const gate=barrier();let renewals=0
 const f=fixture(t,async(path)=>{if(path.endsWith('/renew')){renewals++;gate.enter();await gate.gate}})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const first=f.host.renewLease(f.fileId);await gate.entered
 const second=f.host.renewLease(f.fileId);gate.release()
 await Promise.all([first,second]);assert.equal(renewals,1);assert.ok(f.host.getState(f.fileId).lease)
})

test('takeover is fenced from a renewal that arrives while its lease GET is blocked',async t=>{
 const renew=barrier(),takeover=barrier()
 const f=fixture(t,async(path,init,{lease,setEpoch})=>{
  if(path.endsWith('/renew')){renew.enter();await renew.gate;return json({},409)}
  if(path.endsWith('/lease')&&!init.method){takeover.enter();await takeover.gate;return json({...lease(),active:true})}
  if(path.endsWith('/takeover')){setEpoch(2);return json(lease())}
 })
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const old=f.host.renewLease(f.fileId),rejected=assert.rejects(old,{code:'CONFLICT'});await renew.entered
 const claiming=f.host.takeoverLease(f.fileId);await takeover.entered
 renew.release();await rejected
 assert.ok(f.host.getState(f.fileId).lease,'stale renewal must not clear authority after takeover starts')
 takeover.release();await claiming;assert.equal(f.host.getState(f.fileId).lease.leaseEpoch,2)
})

test('expired authority disappears locally even while a renewal fetch remains blocked',async t=>{
 const gate=barrier()
 const f=fixture(t,async(path,init,{lease})=>{
  if(path.endsWith('/lease')&&init.method==='POST')return json({...lease(),expiresAt:new Date(Date.now()+100).toISOString()})
  if(path.endsWith('/renew')){gate.enter();await gate.gate;return json({...lease(),expiresAt:new Date(Date.now()-1).toISOString()})}
 })
 t.mock.timers.enable({apis:['Date','setTimeout']})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const renewing=f.host.renewLease(f.fileId),rejected=assert.rejects(renewing);await gate.entered
 t.mock.timers.tick(101)
 assert.equal(f.host.getState(f.fileId).lease,null)
 gate.release();await rejected
 assert.equal(f.host.getState(f.fileId).lease,null)
})

for(const expiry of ['timer','state read'])test(`a future renewal receipt restores authority after local expiry by ${expiry}`,async t=>{
 const gate=barrier();let renewed
 t.mock.timers.enable({apis:expiry==='timer'?['Date','setTimeout']:['Date']})
 const f=fixture(t,async(path,init,{lease})=>{
  if(path.endsWith('/lease')&&init.method==='POST')return json({...lease(),expiresAt:new Date(Date.now()+100).toISOString()})
  if(path.endsWith('/renew')){
   // The server renewed before the original expiry; only delivery is delayed.
   renewed={...lease(),expiresAt:new Date(Date.now()+60000).toISOString()}
   gate.enter();await gate.gate;return json(renewed)
  }
 })
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const renewing=f.host.renewLease(f.fileId);await gate.entered
 let notifications=0;f.host.subscribe(()=>{notifications++})
 t.mock.timers.tick(101)
 const beforeRead=notifications
 assert.equal(f.host.getState(f.fileId).lease,null,'local expiry must immediately disable writes')
 assert.equal(f.host.getState(f.fileId).status,'conflict')
 assert.equal(notifications,beforeRead,'getState must not notify subscribers')
 await assert.rejects(f.host.saveSheets(f.fileId,{}),{code:'CONFLICT'})
 gate.release();assert.deepEqual(await renewing,renewed)
 assert.deepEqual(f.host.getState(f.fileId).lease,renewed)
 assert.equal(f.host.getState(f.fileId).status,'idle')
 assert.equal(notifications,beforeRead+1,'the accepted renewal notifies the editor to restore editing')
})

for(const action of ['release','takeover'])test(`local expiry cannot let a delayed renewal bypass explicit ${action}`,async t=>{
 const gate=barrier()
 t.mock.timers.enable({apis:['Date','setTimeout']})
 const f=fixture(t,async(path,init,{lease,setEpoch})=>{
  if(path.endsWith('/lease')&&init.method==='POST')return json({...lease(),expiresAt:new Date(Date.now()+100).toISOString()})
  if(path.endsWith('/renew')){const renewed=lease();gate.enter();await gate.gate;return json(renewed)}
  if(path.endsWith('/takeover')){setEpoch(2);return json(lease())}
 })
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const renewing=f.host.renewLease(f.fileId),rejected=assert.rejects(renewing,{code:'CONFLICT'});await gate.entered
 t.mock.timers.tick(101);assert.equal(f.host.getState(f.fileId).lease,null)
 if(action==='release')await f.host.releaseLease(f.fileId)
 else await f.host.takeoverLease(f.fileId)
 const expected=f.host.getState(f.fileId).lease
 gate.release();await rejected
 assert.deepEqual(f.host.getState(f.fileId).lease,expected)
 assert.equal(expected?.leaseEpoch??null,action==='release'?null:2)
})

test('renewal cannot supersede takeover while its lease GET is pending',async t=>{
 const gate=barrier();let renewals=0
 const f=fixture(t,async(path,init)=>{
  if(path.endsWith('/lease')&&!init.method){gate.enter();await gate.gate}
  if(path.endsWith('/renew'))renewals++
 })
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const claiming=f.host.takeoverLease(f.fileId);await gate.entered
 await assert.rejects(f.host.renewLease(f.fileId),{code:'CONFLICT'})
 gate.release();await claiming;assert.equal(renewals,0);assert.ok(f.host.getState(f.fileId).lease)
})

test('save conflict fences a previously successful renewal reply held in flight',async t=>{
 const gate=barrier()
 const f=fixture(t,async(path)=>{
  if(path.endsWith('/renew')){gate.enter();await gate.gate}
  if(path.endsWith('/sheets/uploads'))return json({},409)
 })
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const renewing=f.host.renewLease(f.fileId),rejected=assert.rejects(renewing,{code:'CONFLICT'});await gate.entered
 await assert.rejects(f.host.saveSheets(f.fileId,{}),{code:'CONFLICT'})
 gate.release();await rejected
 assert.equal(f.host.getState(f.fileId).lease,null)
})

test('page exit dispatches keepalive release before disposal',async t=>{
 let dispatched=false
 const f=fixture(t,(path,init)=>{if(path.endsWith('/lease')&&init.method==='DELETE'){assert.equal(init.keepalive,true);dispatched=true}})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const releasing=f.host.releaseLease(f.fileId,true)
 f.host.dispose();await releasing;assert.equal(dispatched,true)
})

test('an expired state read does not synchronously notify a React subscriber',async t=>{
 const f=fixture(t,async(path,init,{lease})=>{if(path.endsWith('/lease')&&init.method==='POST')return json({...lease(),expiresAt:new Date(Date.now()+100).toISOString()})})
 t.mock.timers.enable({apis:['Date']})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 let notifications=0;f.host.subscribe(()=>{notifications++})
 t.mock.timers.tick(101)
 assert.equal(f.host.getState(f.fileId).lease,null);assert.equal(notifications,0)
})

test('head refresh preserves lease',async t=>{
 const f=fixture(t);await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const lease=f.host.getState(f.fileId).lease
 f.revision.revision=randomUUID()
 await f.host.refreshHead(f.fileId)
 assert.equal(f.host.getState(f.fileId).revision.revision,f.revision.revision)
 assert.deepEqual(f.host.getState(f.fileId).lease,lease)
})


test('realtime notices fence a superseded editor without adopting the remote head or granting a lease', async t => {
 const f=fixture(t)
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 const original=f.host.getState(f.fileId).revision
 const self=f.host.getEditorId()
 f.host.observeRealtime(f.fileId,{lease:{leaseEpoch:0,editorId:null,heldByCurrentSession:false,active:false,expiresAt:null}})
 assert.ok(f.host.getState(f.fileId).lease,'an older lease observation cannot revoke a newer lease')
 f.host.observeRealtime(f.fileId,{lease:{leaseEpoch:2,editorId:randomUUID(),heldByCurrentSession:true,active:true,expiresAt:new Date(Date.now()+60000).toISOString()}})
 assert.equal(f.host.getState(f.fileId).lease,null,'a different editor in the same login is still fenced')
 assert.deepEqual(f.host.getState(f.fileId).revision,original)
 f.host.observeRealtime(f.fileId,{lease:{leaseEpoch:3,editorId:self,heldByCurrentSession:true,active:true,expiresAt:new Date(Date.now()+60000).toISOString()}})
 assert.equal(f.host.getState(f.fileId).lease,null,'only an HTTP lease grant can restore write authority')
 f.host.observeRealtime(f.fileId,null)
 assert.equal(f.host.getState(f.fileId).status,'unauthorized')
})
