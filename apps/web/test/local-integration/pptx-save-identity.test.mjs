import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
// Select the package's documented CJS export consistently under Node and tsx.
const PptxGenJS=createRequire(import.meta.url)('pptxgenjs')
import {fileFixture,importFile} from '../helpers/files.mjs'
import {s3Fixture} from '../helpers/s3.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createSlidesService} from '../../server/src/modules/slides/service.ts'
import {createSlidesSaveService} from '../../server/src/modules/slides/save.ts'

// Real engine, trusted generated documents, in the test process ONLY. This is not
// a child-process fallback or a certified isolation host, and mounts no route.
let createPptxSession,dir
before(async()=>{
 dir=await mkdtemp(join(tmpdir(),'dyoffice-real-pptx-'))
 const outfile=join(dir,'session.cjs')
 await build({entryPoints:[fileURLToPath(new URL('../../worker/src/native/pptx-session.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'cjs',loader:{'.md':'text'},logLevel:'silent'})
 ;({createPptxSession}=await import(pathToFileURL(outfile).href))
})
after(async()=>{if(dir)await rm(dir,{recursive:true,force:true})})
function textOf(slides){return slides.flatMap(s=>s.nodes.flatMap(n=>(n.text?.lines??[]).flatMap(l=>l.runs.map(r=>r.text)))).join('')}
async function fixture(t){
 const s3=await s3Fixture(t),f=await fileFixture(t,{buildApp:false,objectStore:s3.store})
 const deck=new PptxGenJS();deck.addSlide().addText('Original text',{x:1,y:1,w:4,h:1})
 const initial=(await importFile(f,f.alice.token,Buffer.from(await deck.write({outputType:'nodebuffer'})),'real-edit.pptx')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),editorId=randomUUID()
 const lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 const authority={revision:initial.revision,generation:0,editorId,leaseEpoch:lease.leaseEpoch}
 const slides=createSlidesService({files:f.files,leases,revisions,host:{openSession:({bytes},signal)=>createPptxSession(bytes,signal)}})
 t.after(()=>slides.closeAll())
 const preparation=createSlidesSaveService({files:f.files,leases,revisions,sessions:slides})
 const opened=await slides.open(f.alice.token,initial.fileId,authority)
 assert.equal(textOf(opened.slides),'Original text')
 return {...f,s3,initial,leases,revisions,authority,slides,preparation}
}
async function edit(f){const result=await f.slides.apply(f.alice.token,f.initial.fileId,{...f.authority,ops:[{op:'findReplace',find:'Original text',replace:'Edited actual PPTX'}]});assert.equal(result.generation,1);assert.equal(result.dirty,true);return {...f.authority,generation:1}}
async function prepare(f,authority){return f.preparation.prepare(f.alice.token,f.initial.fileId,{baseRevision:f.initial.revision,editorId:authority.editorId,leaseEpoch:authority.leaseEpoch,request:{revision:authority.revision,generation:authority.generation}})}
function commitInput(f,p){return {fileId:f.initial.fileId,uploadId:p.uploadId,baseRevision:p.baseRevision,leaseEpoch:p.leaseEpoch,idempotencyKey:randomUUID()}}
async function state(f){return f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT current_revision FROM files WHERE id=$1) head,(SELECT count(*)::int FROM file_revisions) versions,(SELECT count(*)::int FROM revision_commits) receipts,(SELECT count(*)::int FROM revision_outbox) events,(SELECT reserved_bytes::text FROM storage_accounts WHERE owner_id=$2) reserved',[f.initial.fileId,f.alice.user.id])).rows[0])}
async function assertReopened(f,saved){const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision),session=await createPptxSession(bytes);try{assert.equal(textOf(await session.renderAll(0)),'Edited actual PPTX')}finally{session.close()}}


function saveInput(f,a){return {baseRevision:f.initial.revision,editorId:a.editorId,leaseEpoch:a.leaseEpoch,request:{revision:a.revision,generation:a.generation}}}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
test('PPTX prepare captures caller identity before its first lease await',async t=>{
 const f=await fixture(t),a=await edit(f),input=saveInput(f,a),entered=deferred(),resume=deferred();let first=true
 const leases={...f.leases,async renewLease(...args){if(first){first=false;entered.resolve();await resume.promise}return f.leases.renewLease(...args)}}
 const service=createSlidesSaveService({files:f.files,leases,revisions:f.revisions,sessions:f.slides})
 const pending=service.prepare(f.alice.token,f.initial.fileId,input)
 await entered.promise
 input.baseRevision=randomUUID();input.editorId=randomUUID();input.leaseEpoch+=10;input.request.revision=randomUUID();input.request.generation+=10
 resume.resolve()
 const prepared=await pending
 assert.equal(prepared.baseRevision,f.initial.revision);assert.equal(prepared.leaseEpoch,a.leaseEpoch)
 const saved=await f.revisions.commitRevision(f.alice.token,commitInput(f,prepared))
 assert.equal(saved.sha256,prepared.sha256);assert.equal(saved.size,prepared.size)
 await assertReopened(f,saved)
})
test('PPTX prepare captures exported bytes before awaiting stage; original buffer mutation cannot change saved identity',async t=>{
 const f=await fixture(t),a=await edit(f);let original,expected
 const sessions={...f.slides,async exportForSave(...args){const result=await f.slides.exportForSave(...args);original=result.bytes;expected=Buffer.from(original);return result}}
 const revisions={...f.revisions,async stageUpload(...args){original.fill(0);return f.revisions.stageUpload(...args)}}
 const service=createSlidesSaveService({files:f.files,leases:f.leases,revisions,sessions})
 const prepared=await service.prepare(f.alice.token,f.initial.fileId,saveInput(f,a))
 assert.equal(prepared.sha256,createHash('sha256').update(expected).digest('hex'))
 const saved=await f.revisions.commitRevision(f.alice.token,commitInput(f,prepared))
 assert.deepEqual(await f.files.readFile(f.alice.token,saved.fileId,saved.revision),expected)
 await assertReopened(f,saved)
})
test('PPTX returned export generation must match captured request before any stage',async t=>{
 const f=await fixture(t),a=await edit(f),before=await state(f);let staged=0,bound=0
 const sessions={...f.slides,async exportForSave(...args){const result=await f.slides.exportForSave(...args);return {...result,generation:result.generation+1}},async bindPreparedUpload(...args){bound++;return f.slides.bindPreparedUpload(...args)}}
 const revisions={...f.revisions,async stageUpload(...args){staged++;return f.revisions.stageUpload(...args)}}
 const service=createSlidesSaveService({files:f.files,leases:f.leases,revisions,sessions})
 await assert.rejects(service.prepare(f.alice.token,f.initial.fileId,saveInput(f,a)),{statusCode:409})
 assert.equal(staged,0);assert.equal(bound,0);assert.deepEqual(await state(f),before)
})
for(const field of ['sha256','size','uploadId']){
 test('PPTX actual ready receipt '+field+' mismatch rejects, cancels and never binds',async t=>{
  const f=await fixture(t),a=await edit(f),before=await state(f);let bound=0,realUpload
  const files={...f.files,async receiveUpload(...args){const receipt=await f.files.receiveUpload(...args);realUpload=receipt.uploadId;return {...receipt,[field]:field==='size'?receipt.size+1:field==='sha256'?'0'.repeat(64):randomUUID()}}}
  const sessions={...f.slides,async bindPreparedUpload(...args){bound++;return f.slides.bindPreparedUpload(...args)}}
  const service=createSlidesSaveService({files,leases:f.leases,revisions:f.revisions,sessions})
  await assert.rejects(service.prepare(f.alice.token,f.initial.fileId,saveInput(f,a)),{statusCode:503})
  assert.equal(bound,0);assert.ok(realUpload);assert.deepEqual(await state(f),before)
  const row=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT state FROM uploads WHERE id=$1',[realUpload])).rows[0])
  assert.equal(row.state,'cancelled')
 })
}
