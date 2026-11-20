import {runInNewContext} from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { createDocsBridge } from '../../src/editors/docs-bridge.ts'

test('a native save reporting newer metadata retains an unsaved UI state', async () => {
  const host = { getState: () => ({ name: 'a.docx', status: 'idle' }), save: async () => ({}) }
  const bridge = createDocsBridge(host, 'file', { language: 'en' }, () => {})
  await bridge.lifecycle.beforeSave()
  assert.equal((await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))).ok, true)
  // Native serializer detected newer metadata, although no PM update fired.
  bridge.lifecycle.afterSave(false)
  assert.equal(bridge.getState().nativeSaveOutcome, 'incomplete')
  assert.equal(bridge.getState().dirty, true)
})

test('Web DOCX bridge consumes generated document content once', async () => {
  const content = { title: 'Quarterly report', html: '<h1>Quarterly report</h1><p>Results</p>' }
  const bridge = createDocsBridge(
    { getState: () => ({ name: 'blank.docx', status: 'idle' }) },
    'file',
    { language: 'en' },
    () => {},
    async () => content,
  )
  assert.deepEqual(await bridge.api.consumeAiDocContent(), content)
  assert.equal(await bridge.api.consumeAiDocContent(), null)
})

test('Web docs bridge advertises DOCX and PDF, rejecting Markdown and HTML', async () => {
  const created = []
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const previousParser = globalThis.DOMParser
  globalThis.DOMParser = new JSDOM('').window.DOMParser
  const font = await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url))
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => font.buffer.slice(font.byteOffset,font.byteOffset+font.byteLength) })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { parent: { dyofficeCreateAiDoc: async request => created.push(request) } },
  })
  const bridge = createDocsBridge(
    { getState: () => ({ name: 'blank.docx', status: 'idle' }) },
    'file',
    { language: 'en' },
    () => {},
  )
  try {
    assert.deepEqual(bridge.supportedCreateDocumentTypes, ['docx', 'pdf'])
    assert.deepEqual(await bridge.api.createDocument({ type: 'docx', title: 'Report', content: '<p>Body</p>' }), { ok: true, destination: 'workspace' })
    assert.deepEqual(await bridge.api.createDocument({ type: 'pdf', title: 'Report', content: '<p>Body</p>' }), { ok: true, destination: 'workspace' })
    for (const type of ['md', 'html']) {
      assert.deepEqual(await bridge.api.createDocument({ type, title: 'Report', content: 'Body' }), { ok: false, error: 'This feature is currently unavailable.' })
    }
    assert.deepEqual(created.map(({type,title,content})=>({type,title,content})), [
      { type: 'docx', title: 'Report', content: '<p>Body</p>' },
      { type: 'pdf', title: 'Report', content: '<p>Body</p>' },
    ])
  } finally {
    globalThis.fetch = previousFetch
    if (previousParser === undefined) delete globalThis.DOMParser
    else globalThis.DOMParser = previousParser
    if (previousWindow === undefined) delete globalThis.window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('standalone Word does not advertise creation without a workspace creator', async t => {
  const previousWindow = globalThis.window
  const standalone = {}
  standalone.parent = standalone
  globalThis.window = standalone
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow })
  const bridge = createDocsBridge({ getState: () => ({ name: 'source.docx' }) }, 'file', { language: 'en' }, () => {})
  assert.deepEqual(bridge.supportedCreateDocumentTypes, [])
  const result = await bridge.api.createDocument({ type: 'docx', title: 'Report', content: '<p>Body</p>' })
  assert.equal(result.ok, false)
})

test('Word capability discovery tolerates an inaccessible parent frame', t => {
  const previousWindow = globalThis.window
  globalThis.window = { parent: { get dyofficeCreateAiDoc() { throw new DOMException('Blocked a frame', 'SecurityError') } } }
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow })
  const bridge = createDocsBridge({ getState: () => ({ name: 'source.docx' }) }, 'file', { language: 'en' }, () => {})
  assert.deepEqual(bridge.supportedCreateDocumentTypes, [])
})

 test('a fully accepted native save clears dirty only after the native acknowledgement', async () => {
  const host = { getState: () => ({ name: 'a.docx', status: 'idle' }), save: async () => ({}) }
  const bridge = createDocsBridge(host, 'file', { language: 'en' }, () => {})
  bridge.lifecycle.edited()
  await bridge.lifecycle.beforeSave()
  bridge.lifecycle.edited()
  assert.equal((await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))).ok, true)
  assert.equal(bridge.getState().dirty, true)
  bridge.lifecycle.afterSave(false)
  assert.equal(bridge.getState().nativeSaveOutcome, 'incomplete')
  assert.equal(bridge.getState().dirty, true)
  await bridge.lifecycle.beforeSave()
  await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))
  bridge.lifecycle.afterSave(true)
  assert.equal(bridge.getState().nativeSaveOutcome, 'accepted')
  assert.equal(bridge.getState().dirty, false)
})

test('lost HTTP save cannot become clean through a native acknowledgement', async () => {
  let status='idle'
  const host = { getState: () => ({ name: 'a.docx', status }), save: async () => { status='unknown'; throw Error('response lost') } }
  const bridge = createDocsBridge(host, 'file', { language: 'en' }, () => {})
  bridge.lifecycle.edited()
  await bridge.lifecycle.beforeSave()
  assert.equal((await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))).ok, false)
  bridge.lifecycle.afterSave(true)
  assert.equal(bridge.getState().nativeSaveOutcome, 'accepted')
  assert.equal(bridge.getState().dirty, true)
  assert.equal(bridge.getState().status, 'unknown')
})

import {randomUUID,createHash} from 'node:crypto'
import {createSessionFileHost} from '../../../../packages/browser-host/src/session-files.ts'
const barrier=()=>{let enter,release;return {entered:new Promise(r=>enter=r),gate:new Promise(r=>release=r),enter:()=>enter(),release:()=>release()}}
async function fixture(t){
 const fileId=randomUUID(),editorId=randomUUID(),uploadId=randomUUID(),bytes=new Uint8Array([1,2,3])
 const initial={fileId,revision:randomUUID(),sha256:'a'.repeat(64),size:1},saved={fileId,revision:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}
 let head=initial,commit=async()=>Response.json(saved),changes=0
 const writes=[]
 const host=createSessionFileHost({editorId,leaseRetryDelayMs:0,fetchImpl:async(path,init={})=>{
  if(path.endsWith('/csrf'))return Response.json({csrfToken:'a'.repeat(43)})
  if(path===`/api/v1/files/${fileId}`)return Response.json({file:head,name:'a.docx',format:'docx',capabilities:{docx:'editable',xlsx:'unsupported',pptx:'unsupported',pdf:'unsupported'},downloadEndpoint:`/api/v1/files/${fileId}/content?revision=${head.revision}`})
  if(path.endsWith('/lease'))return Response.json({leaseEpoch:1,editorId,expiresAt:new Date(Date.now()+60000).toISOString()})
  writes.push(path)
  if(path.endsWith('/uploads'))return Response.json({uploadId})
  if(path.endsWith('/content'))return new Response(null,{status:204})
  if(path.endsWith('/commits')){head=saved;return commit()}
  throw Error('Unexpected test request')
 }})
 t.after(()=>host.dispose());await host.open(fileId);await host.acquireLease(fileId)
 const bridge=createDocsBridge(host,fileId,{language:'en'},()=>changes++)
 t.after(()=>bridge.dispose())
 return {bridge,host,fileId,initial,saved,bytes,writes,path:`/files/${fileId}/a.docx`,changes:()=>changes,setCommit:fn=>commit=fn,head:()=>head}
}
for(const outcome of ['confirmed','unknown'])test(`disposed DOCX save cannot acknowledge a late ${outcome} commit or mutate the dead view`,async t=>{
 const f=await fixture(t),hold=barrier()
 f.setCommit(async()=>{hold.enter();await hold.gate;if(outcome==='unknown')throw Error('lost reply');return Response.json(f.saved)})
 f.bridge.lifecycle.edited();await f.bridge.lifecycle.beforeSave()
 const pending=f.bridge.api.saveDocx(f.path,f.bytes.buffer)
 await hold.entered
 f.bridge.dispose();const before=f.bridge.getState(),changes=f.changes();hold.release()
 assert.equal((await pending).ok,false)
 assert.deepEqual(f.bridge.getState(),before);assert.equal(f.changes(),changes);assert.equal(f.bridge.getReceipt(),null)
 assert.deepEqual(f.head(),f.saved,'disposing cannot revoke an already dispatched server commit')
 assert.equal(f.host.getState(f.fileId).status,outcome==='unknown'?'unknown':'idle')
 assert.equal(f.host.getState(f.fileId).revision.revision,outcome==='unknown'?f.initial.revision:f.saved.revision)
 if(outcome==='unknown'){
  f.setCommit(async()=>Response.json(f.saved))
  assert.deepEqual(await f.host.reconcile(f.fileId),f.saved,'the durable unknown remains reconcilable by its live owner')
 }
 assert.equal(f.changes(),changes)
})
test('disposed DOCX bridge rejects new saves and lifecycle starts without requests',async t=>{
 const f=await fixture(t);f.bridge.dispose();const before=f.bridge.getState(),changes=f.changes()
 assert.equal((await f.bridge.api.saveDocx(f.path,f.bytes.buffer)).ok,false)
 await assert.rejects(f.bridge.lifecycle.beforeSave(),{code:'UNAVAILABLE'})
 f.bridge.lifecycle.documentOpened();f.bridge.lifecycle.edited();f.bridge.lifecycle.afterSave(true)
 assert.deepEqual(f.writes,[]);assert.deepEqual(f.bridge.getState(),before);assert.equal(f.changes(),changes)
})
test('dispose during unknown-receipt confirmation preserves the host receipt without starting a new save',async t=>{
 const f=await fixture(t);f.setCommit(async()=>{throw Error('lost reply')})
 f.bridge.lifecycle.edited();await f.bridge.lifecycle.beforeSave()
 assert.equal((await f.bridge.api.saveDocx(f.path,f.bytes.buffer)).ok,false)
 f.bridge.lifecycle.afterSave(false)
 assert.equal(f.bridge.getState().status,'unknown')
 const hold=barrier();f.setCommit(async()=>{hold.enter();await hold.gate;return Response.json(f.saved)})
 const pending=f.bridge.lifecycle.beforeSave();await hold.entered
 f.bridge.dispose();const before=f.bridge.getState(),changes=f.changes();hold.release()
 await assert.rejects(pending,{code:'UNAVAILABLE'})
 assert.deepEqual(f.bridge.getState(),before);assert.equal(f.changes(),changes)
 assert.equal(f.host.getState(f.fileId).status,'idle');assert.deepEqual(f.host.getState(f.fileId).revision,f.saved)
 assert.equal(f.writes.filter(path=>path.endsWith('/uploads')).length,1)
})
test('live DOCX save still acknowledges the exact host receipt',async t=>{
 const f=await fixture(t);f.bridge.lifecycle.edited();await f.bridge.lifecycle.beforeSave()
 assert.equal((await f.bridge.api.saveDocx(f.path,f.bytes.buffer)).ok,true)
 f.bridge.lifecycle.afterSave(true)
 assert.deepEqual(f.bridge.getReceipt(),f.saved);assert.equal(f.bridge.getState().dirty,false)
})
test('disposed guarded save neither starts a new action nor accepts a late action',async t=>{
 const f=await fixture(t),hold=barrier();let actions=0
 const pending=f.bridge.guardedSave(()=>true,async()=>{actions++;hold.enter();await hold.gate;return true})
 await hold.entered;f.bridge.dispose();hold.release()
 assert.equal(await pending,false)
 assert.equal(await f.bridge.guardedSave(()=>true,async()=>{actions++;return true}),false)
 assert.equal(actions,1)
})

test('generated DOCX completion requires native acknowledgement and the exact persisted receipt',async()=>{
 const previousWindow=globalThis.window,completed=[]
 globalThis.window={parent:{dyofficeCompleteAiDocContent:(fileId,result)=>completed.push({fileId,result})}}
 const revision={fileId:'file',revision:'saved',sha256:'a'.repeat(64),size:10}
 const host={getState:()=>({name:'a.docx',status:'idle',lease:{},revision}),save:async()=>revision}
 const bridge=createDocsBridge(host,'file',{language:'en'},()=>{},async()=>({title:'Report',html:'<p>Body</p>'}))
 try{
  await bridge.api.consumeAiDocContent()
  bridge.lifecycle.edited();await bridge.lifecycle.beforeSave()
  await bridge.api.saveDocx('/files/file/a.docx',new ArrayBuffer(10))
  assert.deepEqual(completed,[])
  bridge.lifecycle.afterSave(true)
  bridge.lifecycle.aiDocumentCreated(true)
  assert.deepEqual(completed,[{fileId:'file',result:{ok:true,revision}}])
  bridge.dispose();assert.equal(completed.length,1)
 }finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow}
})
test('closing an unpersisted generated DOCX reports failure to the initiating tool',async()=>{
 const previousWindow=globalThis.window,completed=[]
 globalThis.window={parent:{dyofficeCompleteAiDocContent:(_fileId,result)=>completed.push(result)}}
 const bridge=createDocsBridge({getState:()=>({name:'a.docx',status:'idle'})},'file',{language:'en'},()=>{},async()=>({title:'Report',html:'<p>Body</p>'}))
 try{
  await bridge.api.consumeAiDocContent();bridge.dispose()
  assert.equal(completed.length,1);assert.equal(completed[0].ok,false)
 }finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow}
})

test('generated DOCX rejects incomplete, missing or mismatched persistence receipts',async()=>{
 const previousWindow=globalThis.window
 try{
  for(const kind of ['native-pending','incomplete','mismatched','unknown']){
   const completed=[]
   globalThis.window={parent:{dyofficeCompleteAiDocContent:(_fileId,result)=>completed.push(result)}}
   const revision={fileId:'file',revision:'saved',sha256:'a'.repeat(64),size:10}
   let status='idle'
   const host={getState:()=>({name:'a.docx',status,lease:{},revision}),save:async()=>{
    if(kind==='unknown'){status='unknown';throw Error('lost receipt')}
    return {...revision,revision:kind==='mismatched'?'other':'saved'}
   }}
   const bridge=createDocsBridge(host,'file',{language:'en'},()=>{},async()=>({title:'Report',html:'<p>Body</p>'}))
   await bridge.api.consumeAiDocContent();bridge.lifecycle.edited();await bridge.lifecycle.beforeSave()
   await bridge.api.saveDocx('/files/file/a.docx',new ArrayBuffer(10))
   if(kind!=='native-pending')bridge.lifecycle.afterSave(kind!=='incomplete')
   bridge.lifecycle.aiDocumentCreated(true)
   assert.equal(completed.length,1,kind);assert.equal(completed[0].ok,false,kind)
   bridge.dispose()
  }
 }finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow}
})


test('DOCX creation preserves parent-frame save failures across JavaScript realms',async()=>{
 const previousWindow=globalThis.window
 const error=runInNewContext('new Error("Word 正文未确认保存")')
 assert.equal(error instanceof Error,false)
 globalThis.window={parent:{dyofficeCreateAiDoc:async()=>{throw error}}}
 const bridge=createDocsBridge({getState:()=>({name:'a.docx',status:'idle'})},'file',{language:'en'},()=>{})
 try{
  assert.deepEqual(await bridge.api.createDocument({type:'docx',title:'Report',content:'<p>Body</p>'}),{ok:false,error:'Word 正文未确认保存'})
 }finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow}
})
