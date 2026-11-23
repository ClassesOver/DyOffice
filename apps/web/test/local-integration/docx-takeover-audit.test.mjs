import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'

async function fixture(t, customize) {
  const f = await fileFixture(t), original = await docxBytes(), opened = await importFile(f,f.alice.token,original,'browser-host.docx')
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' })
  const fetchImpl = (path, init = {}) => fetch(address + path,{ ...init,headers: { ...Object.fromEntries(new Headers(init.headers)), origin: 'https://office.example', cookie: '__Host-dyoffice-session=' + f.alice.token } })
  const { createSessionFileHost } = await import('../../../../packages/browser-host/src/files.ts')
  const host = createSessionFileHost({ fetchImpl: customize ? customize(fetchImpl) : fetchImpl, editorId: randomUUID() })
  t.after(() => host.dispose())
  await host.open(opened.file.fileId); await host.acquireLease(opened.file.fileId)
  return { ...f, host, fetchImpl, original, fileId: opened.file.fileId, initial: opened.file }
}
async function changed(bytes, text) {
  const zip = await JSZip.loadAsync(bytes)
  zip.file('word/document.xml',(await zip.file('word/document.xml').async('string')).replace('</w:body>',`<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>`))
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

const {createSessionFileHost}=await import('../../../../packages/browser-host/src/files.ts')
const {createDocsBridge}=await import('../../src/editors/docs-bridge.ts')
test('real HTTP stale DOCX takeover grants lease but preserves old baseline and then rejects save',async t=>{
 const f=await fixture(t),b=createSessionFileHost({fetchImpl:f.fetchImpl,editorId:randomUUID()});t.after(()=>b.dispose())
 await b.open(f.fileId);await assert.rejects(b.acquireLease(f.fileId),{code:'CONFLICT'})
 const bridge=createDocsBridge(b,f.fileId,{language:'en',theme:'light'},()=>{});t.after(()=>bridge.dispose())
 bridge.lifecycle.documentOpened()
 const savedA=await f.host.save(f.fileId,await changed(f.original,'A durable latest'))
 await b.takeoverLease(f.fileId)
 assert.equal(b.getState(f.fileId).status,'idle');assert.ok(b.getState(f.fileId).lease)
 assert.equal(b.getState(f.fileId).revision.revision,f.initial.revision)
 assert.notEqual(b.getState(f.fileId).revision.revision,savedA.revision)
 bridge.lifecycle.edited();await bridge.lifecycle.beforeSave()
 const draftB=await changed(f.original,'B draft after takeover')
 const result=await bridge.api.saveDocx(`/files/${f.fileId}/browser-host.docx`,draftB.slice().buffer)
 bridge.lifecycle.afterSave(result.ok)
 assert.equal(result.ok,false);assert.equal(bridge.getState().dirty,true);assert.equal(b.getState(f.fileId).status,'conflict')
 const head=await f.files.openFile(f.alice.token,f.fileId);assert.equal(head.file.revision,savedA.revision)
 const xml=await (await JSZip.loadAsync(await f.files.readFile(f.alice.token,f.fileId,head.file.revision))).file('word/document.xml').async('string')
 assert.match(xml,/A durable latest/);assert.doesNotMatch(xml,/B draft after takeover/)
 console.log('takeover-proof',JSON.stringify({leaseGrantedWithStaleBase:true,saveRejected:true,dirtyPreserved:true,newerServerBytesPreserved:true}))
})
test('real HTTP unknown commit survives takeover and reconciles without replaying a new write',async t=>{
 let drop=true,commits=[]
 const f=await fixture(t,real=>async(path,init)=>{const reply=await real(path,init);if(path.endsWith('/commits')){commits.push(JSON.parse(init.body));if(drop){drop=false;await reply.arrayBuffer();throw Error('lost response')}}return reply})
 const bridge=createDocsBridge(f.host,f.fileId,{language:'en',theme:'light'},()=>{});t.after(()=>bridge.dispose())
 bridge.lifecycle.documentOpened();bridge.lifecycle.edited();await bridge.lifecycle.beforeSave()
 const bytes=await changed(f.original,'unknown committed')
 const result=await bridge.api.saveDocx(`/files/${f.fileId}/browser-host.docx`,bytes.slice().buffer);bridge.lifecycle.afterSave(result.ok)
 assert.equal(result.ok,false);assert.equal(f.host.getState(f.fileId).status,'unknown');assert.equal(bridge.getState().dirty,true)
 const before=f.host.getState(f.fileId)
 await assert.rejects(bridge.takeover({isDirty:()=>false}),/Unsaved changes/)
 assert.equal(f.host.getState(f.fileId).lease?.leaseEpoch,before.lease?.leaseEpoch)
 await f.host.takeoverLease(f.fileId)
 assert.equal(f.host.getState(f.fileId).status,'unknown');assert.equal(bridge.getState().dirty,true)
 await f.host.reconcile(f.fileId);assert.deepEqual(commits[0],commits[1]);assert.equal(f.host.getState(f.fileId).status,'idle')
 assert.equal((await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query('SELECT * FROM revision_commits'))).rowCount,1)
})
test('safe DOCX takeover rejects a newer server head without changing baseline or acquiring authority',async t=>{
 const f=await fixture(t),b=createSessionFileHost({fetchImpl:f.fetchImpl,editorId:randomUUID()});t.after(()=>b.dispose())
 await b.open(f.fileId);await assert.rejects(b.acquireLease(f.fileId))
 const bridge=createDocsBridge(b,f.fileId,{language:'en',theme:'light'},()=>{});t.after(()=>bridge.dispose());bridge.lifecycle.documentOpened()
 const saved=await f.host.save(f.fileId,await changed(f.original,'newer head'))
 await assert.rejects(bridge.takeover({isDirty:()=>false}),/newer version/)
 assert.equal(b.getState(f.fileId).revision.revision,f.initial.revision);assert.equal(b.getState(f.fileId).lease,null)
 assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,saved.revision)
})
test('safe DOCX takeover rejects dirty renderer state and accepts clean unchanged revision',async t=>{
 const f=await fixture(t),b=createSessionFileHost({fetchImpl:f.fetchImpl,editorId:randomUUID()});t.after(()=>b.dispose())
 await b.open(f.fileId);await assert.rejects(b.acquireLease(f.fileId))
 const bridge=createDocsBridge(b,f.fileId,{language:'en',theme:'light'},()=>{});t.after(()=>bridge.dispose());bridge.lifecycle.documentOpened()
 await assert.rejects(bridge.takeover({isDirty:()=>true}),/Unsaved changes/)
 assert.equal(b.getState(f.fileId).lease,null)
 await bridge.takeover({isDirty:()=>false});assert.ok(b.getState(f.fileId).lease);assert.equal(b.getState(f.fileId).revision.revision,f.initial.revision)
 bridge.lifecycle.edited();await bridge.lifecycle.beforeSave();const bytes=await changed(f.original,'clean takeover edit')
 const saved=await bridge.api.saveDocx(`/files/${f.fileId}/browser-host.docx`,bytes.slice().buffer);bridge.lifecycle.afterSave(saved.ok)
 assert.equal(saved.ok,true);assert.equal(bridge.getState().dirty,false)
})
test('edit arriving while takeover response waits is preserved and the new lease is released',async t=>{
 const f=await fixture(t);let release,entered;const wait=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let hold=false
 const b=createSessionFileHost({editorId:randomUUID(),fetchImpl:async(path,init)=>{const response=await f.fetchImpl(path,init);if(hold&&path.endsWith('/takeover')){entered();await wait}return response}});t.after(()=>b.dispose())
 await b.open(f.fileId);await assert.rejects(b.acquireLease(f.fileId));const bridge=createDocsBridge(b,f.fileId,{language:'en',theme:'light'},()=>{});t.after(()=>bridge.dispose());bridge.lifecycle.documentOpened()
 hold=true;const taking=bridge.takeover({isDirty:()=>false}),rejected=assert.rejects(taking,/Unsaved changes/);await ready
 bridge.lifecycle.edited();assert.equal((await bridge.api.saveDocx(`/files/${f.fileId}/browser-host.docx`,new ArrayBuffer(1))).ok,false)
 release();await rejected;assert.equal(bridge.getState().dirty,true);assert.equal(b.getState(f.fileId).lease,null);assert.equal(b.getState(f.fileId).revision.revision,f.initial.revision)
 assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,f.initial.revision)
})
test('head changing between initial check and lease takeover cannot bind stale DOCX content',async t=>{
 const f=await fixture(t);let race=false,saved
 const b=createSessionFileHost({editorId:randomUUID(),fetchImpl:async(path,init)=>{const reply=await f.fetchImpl(path,init);if(race&&path===`/api/v1/files/${f.fileId}`){race=false;await reply.clone().arrayBuffer();saved=await f.host.save(f.fileId,await changed(f.original,'raced newer head'))}return reply}});t.after(()=>b.dispose())
 await b.open(f.fileId);await assert.rejects(b.acquireLease(f.fileId));const bridge=createDocsBridge(b,f.fileId,{language:'en',theme:'light'},()=>{});t.after(()=>bridge.dispose());bridge.lifecycle.documentOpened()
 race=true;await assert.rejects(bridge.takeover({isDirty:()=>false}),/newer version/)
 assert.ok(saved);assert.equal(b.getState(f.fileId).revision.revision,f.initial.revision);assert.equal(b.getState(f.fileId).lease,null);assert.equal(bridge.getState().dirty,false)
 assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,saved.revision)
})
