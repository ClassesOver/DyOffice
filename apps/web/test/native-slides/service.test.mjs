import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {fileFixture,importFile,docxBytes} from '../helpers/files.mjs'
import {openIsolatedPptxSession} from '../../worker/src/native/pptx-session-host.ts'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createSlidesService} from '../../server/src/modules/slides/service.ts'
const bytes=()=>readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url))
const host={openSession(input,_signal){return openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,unsafeTestOnly:true})}}
const ops=(el,text)=>[{op:'setText',target:{slide:0,el},paragraphs:[{runs:[{text}]}]}]

async function fixture(t,options={}){
 const f=await fileFixture(t),file=await importFile(f,f.alice.token,await bytes(),'acceptance.pptx')
 const leases=createLeaseService({transactions:f.transactions}),editorId=randomUUID()
 const lease=await leases.acquireLease(f.alice.token,file.file.fileId,{editorId}),authority={editorId,leaseEpoch:lease.leaseEpoch}
 const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const service=createSlidesService({files:f.files,leases,revisions,host,maxSessions:4,sessionIdleMs:60000,...options})
 t.after(()=>service.closeAll())
 return {...f,file,leases,authority,revisions,service}
}

test('slides open is revision-pinned, ownership-checked and returns the full renderer state',async t=>{
 const f=await fixture(t)
 // Foreign owners and unknown files never reach the session host.
 await assert.rejects(()=>f.service.open(f.bob.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0}),{statusCode:404})
 await assert.rejects(()=>f.service.open(f.alice.token,randomUUID(),{...f.authority,revision:f.file.file.revision,generation:0}),{statusCode:404})
 const opened=await f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 assert.equal(opened.generation,0)
 assert.equal(opened.dirty,false)
 assert.equal(opened.slides.length,2)
 assert.deepEqual(opened.history,{canUndo:false,canRedo:false})
 assert.ok(opened.size.cx>0)
 assert.ok(opened.defaultFont.length>0)
 assert.equal(opened.slides[0].partPath,'ppt/slides/slide1.xml')
 // Reopening the same pinned session refreshes the same state (idempotent open).
 const reopened=await f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 assert.equal(reopened.generation,0)
 await assert.rejects(()=>f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:9}),{statusCode:409})
 // Only pptx sessions are admitted.
 const doc=await importFile(f,f.alice.token,await docxBytes(),'native-roundtrip.docx')
 await f.leases.acquireLease(f.alice.token,doc.file.fileId,{editorId:f.authority.editorId})
 await assert.rejects(()=>f.service.open(f.alice.token,doc.file.fileId,{...f.authority,revision:doc.file.revision,generation:0}),{statusCode:415})
})

test('apply fences generations and reports changed indices, order and history',async t=>{
 const f=await fixture(t)
 await f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 const el='e_904989a1'
 await assert.rejects(()=>f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:1,ops:ops(el,'x')}),{statusCode:409})
 await assert.rejects(()=>f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0,ops:[{op:'addPicture',target:{slide:0},offset:{x:0,y:0,cx:1,cy:1},bytes:'aGk=',ext:'png'}]}),{statusCode:400})
 const applied=await f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0,ops:ops(el,'web edit')})
 assert.equal(applied.generation,1)
 assert.equal(applied.dirty,true)
 assert.deepEqual(applied.changed,[0])
 assert.equal(applied.order,undefined)
 assert.deepEqual(applied.history,{canUndo:true,canRedo:false})
 const structural=await f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:1,ops:[{op:'duplicateSlide',target:{slide:0}}]})
 assert.equal(structural.generation,2)
 assert.deepEqual(structural.changed,[1],'the inserted slide is part of the changed set')
 assert.equal(structural.index,1)
 assert.equal(structural.created[0].id,'s_3')
 assert.equal(structural.created[0].slide,1)
 const addedShape=await f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:2,ops:[{op:'addElement',target:{slide:2},kind:'roundRect',offset:{x:914400,y:914400,cx:1828800,cy:914400},fill:'#204060'}]})
 assert.equal(addedShape.generation,3)
 assert.equal(addedShape.created[0].slide,2)
 assert.equal(addedShape.created[0].index,2)/* copied slide already has two elements */
 assert.match(addedShape.created[0].id,/^spnew_/)
 const notes=await f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:3,ops:[{op:'setNotes',target:{slide:0},text:'speaker notes'}]})
 assert.equal(notes.generation,4)
 await assert.rejects(()=>f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:4,ops:[{op:'setNotes',target:{slide:0},text:'x'.repeat(65537)}]}),{statusCode:400})
 assert.deepEqual(structural.order,['ppt/slides/slide1.xml','ppt/slides/slide3.xml','ppt/slides/slide2.xml'])
 assert.deepEqual(structural.sections,[])
 const read=await f.service.slides(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:4})
 assert.equal(read.slides.length,3)
 const single=await f.service.slide(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:4,index:1})
 assert.equal(single.partPath,'ppt/slides/slide3.xml')
 await assert.rejects(()=>f.service.slide(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:4,index:9}),{statusCode:409})
})

test('image mutation rejects a slide outside the deck before invoking the worker',async t=>{
 const f=await fixture(t)
 await f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 await assert.rejects(()=>f.service.applyImage(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0,mode:'insert',slide:9,xPx:0,yPx:0,wPx:100,hPx:100,fitWidthPx:1280,bytesBase64:'aGVsbG8=',ext:'png'}),{statusCode:400})
})

test('undo and redo return full slide sets and report nothing-to-do without changing generations',async t=>{
 const f=await fixture(t)
 await f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 await f.service.apply(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0,ops:[{op:'duplicateSlide',target:{slide:0}}]})
 const undone=await f.service.undo(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:1})
 assert.equal(undone.generation,2)
 assert.equal(undone.dirty,false,'undoing back to the opened state is clean again')
 assert.equal(undone.slides.length,2)
 assert.deepEqual(undone.history,{canUndo:false,canRedo:true})
 const again=await f.service.undo(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:2})
 assert.equal(again.generation,2,'a failed undo keeps the generation')
 assert.equal(again.slides,null)
 assert.equal(again.dirty,false)
 const redone=await f.service.redo(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:2})
 assert.equal(redone.generation,3)
 assert.equal(redone.slides.length,3)
 assert.equal(redone.dirty,true)
})

test('sessions reject foreign accounts and admission bounds captured session starts',async t=>{
 const f=await fixture(t)
 const opened=await f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 // bob cannot touch alice's session even though the file id is a real owned file.
 await assert.rejects(()=>f.service.apply(f.bob.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0,ops:[]}),{statusCode:404})
 await assert.rejects(()=>f.service.undo(f.bob.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0}),{statusCode:404})
 assert.equal(opened.generation,0)
 let release,started
 const entered=new Promise(resolve=>{started=resolve}),gate=new Promise(resolve=>{release=resolve})
 const wrapped={openSession(input,signal){started();return gate.then(()=>host.openSession(input,signal))}}
 const slow=createSlidesService({files:f.files,leases:f.leases,revisions:f.revisions,host:wrapped,maxConcurrent:1})
 t.after(()=>slow.closeAll())
 const pending=slow.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 await entered
 // The existing session short-circuits without a new host slot.
 await assert.rejects(()=>slow.open(f.alice.token,randomUUID(),{...f.authority,revision:f.file.file.revision,generation:0}),{statusCode:404})
 await f.sessions.revoke(f.alice.token,f.alice.sessionId)
 release()
 await assert.rejects(pending)
})

test('session slots are bounded and released after failures',async t=>{
 const f=await fixture(t,{maxSessions:1})
 await f.service.open(f.alice.token,f.file.file.fileId,{...f.authority,revision:f.file.file.revision,generation:0})
 // A second file cannot start a session while the only slot is live.
 const second=await importFile(f,f.alice.token,await bytes(),'second.pptx')
 await f.leases.acquireLease(f.alice.token,second.file.fileId,{editorId:f.authority.editorId})
 await assert.rejects(()=>f.service.open(f.alice.token,second.file.fileId,{...f.authority,revision:second.file.revision,generation:0}),{statusCode:429})
 f.service.closeAll()
 const reopened=await f.service.open(f.alice.token,second.file.fileId,{...f.authority,revision:second.file.revision,generation:0})
 assert.equal(reopened.generation,0)
})

test('exportForSave fences the session and a T06 commit of those bytes is adopted as the new pin',async t=>{
 const f=await fixture(t)
 const fileId=f.file.file.fileId,base=f.file.file.revision
 await f.service.open(f.alice.token,fileId,{...f.authority,revision:base,generation:0})
 const el='e_904989a1'
 await f.service.apply(f.alice.token,fileId,{...f.authority,revision:base,generation:0,ops:ops(el,'saved edit')})
 const {editorId}=f.authority,lease=f.authority
 const draft=await f.service.exportForSave(f.alice.token,fileId,{...f.authority,revision:base,generation:1})
 assert.equal(draft.generation,1)
 // A stale generation never exports old bytes.
 await assert.rejects(()=>f.service.exportForSave(f.alice.token,fileId,{...f.authority,revision:base,generation:0}),{statusCode:409})
 const upload=await f.revisions.stageUpload(f.alice.token,fileId,{size:draft.bytes.byteLength,baseRevision:base,leaseEpoch:lease.leaseEpoch,editorId})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,draft.bytes)
 await f.service.bindPreparedUpload(f.alice.token,fileId,{...f.authority,revision:base,generation:1,uploadId:upload.uploadId})
 const committed=await f.revisions.commitRevision(f.alice.token,{fileId,uploadId:upload.uploadId,baseRevision:base,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.notEqual(committed.revision,base)
 // The head moved: an unrelated revision never matches, and unknown pins conflict.
 await assert.rejects(()=>f.service.slides(f.alice.token,fileId,{...f.authority,revision:randomUUID(),generation:1}),{statusCode:409})
 // Old pins are rejected before mutation; only the committed head adopts the draft.
 await assert.rejects(()=>f.service.apply(f.alice.token,fileId,{...f.authority,revision:base,generation:1,ops:ops(el,'stale')}),{statusCode:409})
 const applied=await f.service.apply(f.alice.token,fileId,{...f.authority,revision:committed.revision,generation:1,ops:ops(el,'after commit')})
 assert.equal(applied.generation,2)
 assert.equal(applied.dirty,true)
 const head=(await f.files.openFile(f.alice.token,fileId)).file.revision
 assert.notEqual(head,base)
 const view=await f.service.slides(f.alice.token,fileId,{...f.authority,revision:head,generation:2})
 assert.equal(view.generation,2)
 assert.equal(view.slides.length,2)
})

test('AI checkpoint restoration after a real committed revision is dirty and preserves the saved head',async t=>{
 const f=await fixture(t),fileId=f.file.file.fileId,base=f.file.file.revision
 const input={...f.authority,revision:base,generation:0}
 const original=await f.service.open(f.alice.token,fileId,input)
 await f.service.beginHistoryBatch(f.alice.token,fileId,input)
 await f.service.apply(f.alice.token,fileId,{...input,ops:ops('e_904989a1','AI saved body')})
 const {snapshotId,history}=await f.service.endHistoryBatch(f.alice.token,fileId,{...input,generation:1})
 assert.equal(typeof snapshotId,'number');assert.equal(history.canUndo,true)
 const draft=await f.service.exportForSave(f.alice.token,fileId,{...input,generation:1})
 const upload=await f.revisions.stageUpload(f.alice.token,fileId,{size:draft.bytes.byteLength,baseRevision:base,...f.authority})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,draft.bytes)
 await f.service.bindPreparedUpload(f.alice.token,fileId,{...input,generation:1,uploadId:upload.uploadId})
 const saved=await f.revisions.commitRevision(f.alice.token,{fileId,uploadId:upload.uploadId,baseRevision:base,leaseEpoch:f.authority.leaseEpoch,idempotencyKey:randomUUID()})
 const current={...input,revision:saved.revision,generation:1}
 assert.equal((await f.service.open(f.alice.token,fileId,current)).dirty,false)
 await assert.rejects(f.service.restoreSnapshot(f.bob.token,fileId,{...current,snapshotId}),error=>[404,409].includes(error.statusCode))
 const restored=await f.service.restoreSnapshot(f.alice.token,fileId,{...current,snapshotId})
 assert.equal(restored.dirty,true)
 assert.equal(restored.generation,2)
 assert.deepEqual(restored.slides,original.slides)
 assert.equal((await f.files.openFile(f.alice.token,fileId)).file.revision,saved.revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,fileId,saved.revision),Buffer.from(draft.bytes))
})
