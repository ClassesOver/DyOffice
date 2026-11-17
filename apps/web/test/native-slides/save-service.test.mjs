import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createSlidesService} from '../../server/src/modules/slides/service.ts'
import {createSlidesSaveService} from '../../server/src/modules/slides/save.ts'
const bytes=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
const host={openSession(input,_signal){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}
const ops=(el,text)=>[{op:'setText',target:{slide:0,el},paragraphs:[{runs:[{text}]}]}]

async function fixture(t){
 const f=await fileFixture(t),file=await importFile(f,f.alice.token,await bytes(),'acceptance.pptx')
 const leases=createLeaseService({transactions:f.transactions})
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const sessions=createSlidesService({files:f.files,leases,revisions,host})
 t.after(()=>sessions.closeAll())
 const saves=createSlidesSaveService({files:f.files,leases,revisions,sessions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,file.file.fileId,{editorId})
 return {...f,file,leases,revisions,sessions,saves,editorId,input:{baseRevision:file.file.revision,leaseEpoch:lease.leaseEpoch,editorId}}
}

test('a session export stages a T06 upload and commits exactly once, preserving unrelated parts',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId
 await f.sessions.open(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0})
 await f.sessions.apply(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0,ops:ops('e_904989a1','web edit')})
 const draft=await f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}})
 assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,f.input.baseRevision)
 const commit={fileId,uploadId:draft.uploadId,baseRevision:f.input.baseRevision,leaseEpoch:f.input.leaseEpoch,idempotencyKey:randomUUID()}
 const saved=await f.revisions.commitRevision(f.alice.token,commit)
 assert.equal(saved.sha256,draft.sha256);assert.equal(saved.size,draft.size)
 assert.deepEqual(await f.revisions.commitRevision(f.alice.token,commit),saved)
 assert.deepEqual(await f.files.readFile(f.alice.token,fileId,f.input.baseRevision),await bytes())
 const output=await f.files.readFile(f.alice.token,fileId,saved.revision)
 const before=await JSZip.loadAsync(await bytes()),after=await JSZip.loadAsync(output)
 assert.match(await after.file('ppt/slides/slide1.xml').async('string'),/web edit/)
 assert.deepEqual(await before.file('customXml/t10-preserve.xml').async('nodebuffer'),await after.file('customXml/t10-preserve.xml').async('nodebuffer'))
 // The committed head carries the exported bytes: the session can be adopted on it.
 const view=await f.sessions.slides(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:saved.revision,generation:1})
 assert.equal(view.generation,1)
 // A stale base revision conflicts without staging anything new.
 await assert.rejects(()=>f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}}),{statusCode:409})
})

test('save export fences the session generation and a stale one never stages',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId
 await f.sessions.open(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0})
 await f.sessions.apply(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0,ops:ops('e_904989a1','moved on')})
 const reservedBefore=(await f.files.usage(f.alice.token)).reservedBytes
 await assert.rejects(()=>f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:0}}),{statusCode:409})
 assert.equal((await f.files.usage(f.alice.token)).reservedBytes,reservedBefore)
 const draft=await f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}})
 assert.match(draft.sha256,/^[a-f0-9]{64}$/)
 assert.equal(draft.baseRevision,f.input.baseRevision)
 assert.equal(draft.leaseEpoch,f.input.leaseEpoch)
 // Foreign owners cannot stage saves on someone else's session.
 await assert.rejects(()=>f.saves.prepare(f.bob.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:1}}),{statusCode:404})
})

test('lease takeover while the export runs fences the output before staging',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId
 await f.sessions.open(f.alice.token,fileId,{editorId:f.editorId,leaseEpoch:f.input.leaseEpoch,revision:f.input.baseRevision,generation:0})
 let release,started
 const entered=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
 // Wrap the sessions' exportForSave to pause mid-export.
 const original=f.sessions.exportForSave.bind(f.sessions)
 f.sessions.exportForSave=(token,id,input,signal)=>{started();return gate.then(()=>original(token,id,input,signal))}
 const pending=f.saves.prepare(f.alice.token,fileId,{...f.input,request:{revision:f.input.baseRevision,generation:0}})
 await entered
 await f.leases.takeoverLease(f.alice.token,fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch})
 release()
 await assert.rejects(pending,{statusCode:409})
 assert.equal((await f.files.usage(f.alice.token)).reservedBytes,0)
 assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,f.input.baseRevision)
})
