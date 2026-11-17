import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {password} from '../helpers/identity.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createSlidesService} from '../../server/src/modules/slides/service.ts'
import {createSlidesSaveService} from '../../server/src/modules/slides/save.ts'

test('real PostgreSQL lease takeover and newer revision fence the old slides draft',async t=>{
 const f=await fileFixture(t),bytes=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url)),file=await importFile(f,f.alice.token,bytes,'review.pptx'),id=file.file.fileId,base=file.file.revision
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,id,{editorId}),request={revision:base,generation:0,editorId,leaseEpoch:lease.leaseEpoch}
 let applied=0,exported=0
 const handle={close(){},outline:async()=>({size:{cx:1,cy:1}}),renderAll:async()=>[],apply:async()=>{applied++;return {generation:1,stateGeneration:1,records:[],created:[],slideIds:[],paths:[]}},exportBytes:async()=>{exported++;return {generation:0,bytes}}}
 // Real database authority and storage, test handle only: no OS/native claim.
 const s=createSlidesService({files:f.files,leases,revisions,host:{openSession:async()=>handle}});t.after(()=>s.closeAll())
 await s.open(f.alice.token,id,request)
 const other=await f.sessions.login('alice',password),nextEditor=randomUUID(),nextLease=await leases.takeoverLease(other.token,id,{editorId:nextEditor,expectedEpoch:lease.leaseEpoch})
 await assert.rejects(()=>s.apply(f.alice.token,id,{...request,ops:[]}),e=>[401,409].includes(e.statusCode));assert.equal(applied,0)
 await assert.rejects(()=>s.apply(other.token,id,{...request,editorId:nextEditor,leaseEpoch:nextLease.leaseEpoch,ops:[]}),{statusCode:409});assert.equal(applied,0)
 const upload=await revisions.stageUpload(other.token,id,{size:bytes.length,baseRevision:base,editorId:nextEditor,leaseEpoch:nextLease.leaseEpoch})
 await f.files.receiveUpload(other.token,upload.uploadId,bytes)
 const committed=await revisions.commitRevision(other.token,{fileId:id,uploadId:upload.uploadId,baseRevision:base,leaseEpoch:nextLease.leaseEpoch,idempotencyKey:randomUUID()})
 const save=createSlidesSaveService({files:f.files,leases,revisions,sessions:s})
 await assert.rejects(()=>save.prepare(other.token,id,{baseRevision:committed.revision,editorId:nextEditor,leaseEpoch:nextLease.leaseEpoch,request:{revision:base,generation:0}}),{statusCode:409});assert.equal(exported,0)
 assert.equal((await f.files.openFile(other.token,id)).file.revision,committed.revision)
})
test('real PostgreSQL adoption proves exact prepared upload and originating session, not equal bytes',async t=>{
 const f=await fileFixture(t),bytes=await readFile(new URL('../fixtures/slides/acceptance.pptx',import.meta.url)),file=await importFile(f,f.alice.token,bytes,'provenance.pptx'),id=file.file.fileId,base=file.file.revision
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,id,{editorId}),request={revision:base,generation:0,editorId,leaseEpoch:lease.leaseEpoch}
 const handle={close(){},outline:async()=>({size:{cx:1,cy:1}}),renderAll:async()=>[],exportBytes:async()=>({generation:0,bytes})}
 const s=createSlidesService({files:f.files,leases,revisions,host:{openSession:async()=>handle}});t.after(()=>s.closeAll())
 const saves=createSlidesSaveService({files:f.files,leases,revisions,sessions:s})
 await s.open(f.alice.token,id,request)
 const prepared=await saves.prepare(f.alice.token,id,{baseRevision:base,editorId,leaseEpoch:lease.leaseEpoch,request:{revision:base,generation:0}})
 const foreign=await revisions.stageUpload(f.alice.token,id,{size:bytes.length,baseRevision:base,editorId,leaseEpoch:lease.leaseEpoch})
 await f.files.receiveUpload(f.alice.token,foreign.uploadId,bytes)
 const committed=await revisions.commitRevision(f.alice.token,{fileId:id,uploadId:foreign.uploadId,baseRevision:base,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()})
 assert.equal(committed.sha256,prepared.sha256)
 await assert.rejects(()=>s.slides(f.alice.token,id,{...request,revision:committed.revision}),{statusCode:409})
 await revisions.verifyUploadCommit(f.alice.token,id,{uploadId:foreign.uploadId,revision:committed.revision,baseRevision:base})
 const other=await f.sessions.login('alice',password)
 await assert.rejects(()=>revisions.verifyUploadCommit(other.token,id,{uploadId:foreign.uploadId,revision:committed.revision,baseRevision:base}),{statusCode:409})
 await assert.rejects(()=>revisions.verifyUploadCommit(f.alice.token,id,{uploadId:prepared.uploadId,revision:committed.revision,baseRevision:base}),{statusCode:409})
})
