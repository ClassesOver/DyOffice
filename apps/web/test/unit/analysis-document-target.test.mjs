import test from 'node:test'
import assert from 'node:assert/strict'
import {createAnalysisDocumentTarget} from '../../../../packages/browser-host/src/analysis-document-target.ts'
const ref={fileId:'f',revision:'r1',sha256:'a'.repeat(64),size:1}
function fixture(){let edit=0,active=true,writes=0,saves=0,receipt=null;const state={revision:ref,lease:{leaseEpoch:1},status:'idle'};const native={captureAnalysis(){const n=edit;return{matches:()=>active&&edit===n,apply:async(_c,check)=>{if(!check()||edit!==n)return false;writes++;edit++;return true}}}};const t=createAnalysisDocumentTarget({fileId:'f',format:'docx',verifyAuthority:async()=>{},state:()=>state,editor:()=>native,save:async()=>{saves++;receipt={...ref,revision:'r2'};state.revision=receipt;return true},receipt:()=>receipt});return{t,state,stats:()=>({writes,saves}),edit:()=>edit++,off:()=>{active=false}}}
const content={kind:'text',text:'literal'},artifact={artifactId:'a',sha256:'b'.repeat(64)}
test('insert is uncommitted, save has a distinct actual receipt',async()=>{const f=fixture(),r=await f.t.apply(f.t.capture(),content,artifact,()=>true);assert.equal(r.status,'applied_uncommitted');assert.deepEqual(f.stats(),{writes:1,saves:0});const s=await f.t.save(r.applicationId,()=>true);assert.equal(s.status,'saved');assert.equal(s.receipt.revision,'r2')})
test('forged capture, changed draft and lease are refused without mutation',async()=>{for(const mode of ['forged','edit','lease']){const f=fixture(),c=f.t.capture();if(mode==='edit')f.edit();if(mode==='lease')f.state.lease.leaseEpoch++;await assert.rejects(f.t.apply(mode==='forged'?{...c}:c,content,artifact,()=>true));assert.equal(f.stats().writes,0)}})
test('capture is single-use and disposal invalidates application',async()=>{const f=fixture(),c=f.t.capture(),r=await f.t.apply(c,content,artifact,()=>true);await assert.rejects(f.t.apply(c,content,artifact,()=>true));f.t.dispose();assert.equal((await f.t.save(r.applicationId,()=>true)).status,'not_confirmed')})
test('new edits after insertion require another explicit decision, not saved claim',async()=>{const f=fixture(),r=await f.t.apply(f.t.capture(),content,artifact,()=>true);f.edit();assert.equal((await f.t.save(r.applicationId,()=>true)).status,'not_confirmed');assert.equal(f.stats().saves,0)})
test('revoked authorization blocks apply and explicit save',async()=>{const f=fixture(),c=f.t.capture();await assert.rejects(f.t.apply(c,content,artifact,()=>false));assert.equal(f.stats().writes,0);const r=await f.t.apply(f.t.capture(),content,artifact,()=>true);assert.equal((await f.t.save(r.applicationId,()=>false)).status,'not_confirmed');assert.equal(f.stats().saves,0)})
test('a successful boolean without a new actual receipt is never saved',async()=>{const native={captureAnalysis(){return {matches:()=>true,apply:async()=>true}}};const t=createAnalysisDocumentTarget({fileId:'f',format:'docx',verifyAuthority:async()=>{},state:()=>({revision:ref,lease:{leaseEpoch:1},status:'idle'}),editor:()=>native,save:async()=>true,receipt:()=>ref});const r=await t.apply(t.capture(),content,artifact,()=>true);assert.equal((await t.save(r.applicationId,()=>true)).status,'not_confirmed')})
test('lease revalidation await cannot land an edit after UI session revocation',async()=>{
 let authorized=true,writes=0;const native={captureAnalysis(){return {matches:()=>true,apply:async(_c,check)=>{if(!check())return false;writes++;return true}}}}
 const t=createAnalysisDocumentTarget({fileId:'f',format:'docx',state:()=>({revision:ref,lease:{leaseEpoch:1},status:'idle'}),editor:()=>native,save:async()=>true,receipt:()=>ref,verifyAuthority:async()=>{authorized=false}})
 await assert.rejects(t.apply(t.capture(),content,artifact,()=>authorized));assert.equal(writes,0)
})
test('same action receipt recovery permits own unknown state but not later authority loss',async()=>{
 const state={revision:ref,lease:{leaseEpoch:1},status:'idle'};let receipt=null
 const native={captureAnalysis(){return{matches:()=>true,matchesForSave:()=>true,apply:async()=>true}}}
 const target=createAnalysisDocumentTarget({fileId:'f',format:'docx',state:()=>state,editor:()=>native,receipt:()=>receipt,verifyAuthority:async()=>{},save:async check=>{
  state.status='unknown';assert.equal(check(),true)
  state.status='unauthorized';assert.equal(check(),false)
  state.status='idle';receipt={...ref,revision:'r2'};state.revision=receipt;return true
 }})
 const applied=await target.apply(target.capture(),content,artifact,()=>true)
 assert.equal((await target.save(applied.applicationId,()=>true)).status,'saved')
})
