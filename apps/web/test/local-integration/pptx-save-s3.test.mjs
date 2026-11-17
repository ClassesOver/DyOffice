import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
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

test('real PPTX edit exports through T06 and RustFS, reopens and adopts only its committed upload',async t=>{
 const f=await fixture(t),before=await state(f),authority=await edit(f),prepared=await prepare(f,authority),input=commitInput(f,prepared)
 assert.equal((await state(f)).head,before.head)
 const saved=await f.revisions.commitRevision(f.alice.token,input)
 assert.deepEqual(await f.revisions.commitRevision(f.alice.token,input),saved)
 assert.equal(saved.sha256,prepared.sha256);await assertReopened(f,saved)
 const adopted=await f.slides.open(f.alice.token,f.initial.fileId,{...authority,revision:saved.revision})
 assert.equal(adopted.dirty,false);assert.equal(textOf(adopted.slides),'Edited actual PPTX')
 const end=await state(f);assert.equal(end.versions,before.versions+1);assert.equal(end.receipts,1);assert.equal(end.events,1);assert.equal(end.reserved,'0')
})
test('stale PPTX generation cannot stage a save after actual edit',async t=>{
 const f=await fixture(t);await edit(f);const before=await state(f)
 await assert.rejects(()=>prepare(f,f.authority),{statusCode:409});assert.deepEqual(await state(f),before)
})
test('lease takeover fences real PPTX prepared output and cannot inherit old dirty session',async t=>{
 const f=await fixture(t),authority=await edit(f),prepared=await prepare(f,authority),before=await state(f),editorId=randomUUID()
 const lease=await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId,expectedEpoch:authority.leaseEpoch})
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,commitInput(f,prepared)),{statusCode:409})
 await assert.rejects(()=>f.slides.exportForSave(f.alice.token,f.initial.fileId,{...authority,editorId,leaseEpoch:lease.leaseEpoch}),{statusCode:409})
 assert.deepEqual(await state(f),before)
 const reopened=await f.slides.open(f.alice.token,f.initial.fileId,{...f.authority,editorId,leaseEpoch:lease.leaseEpoch})
 assert.equal(reopened.dirty,false);assert.equal(textOf(reopened.slides),'Original text')
})
test('real PPTX commit lost client acknowledgement replays original T06 input without re-export',async t=>{
 const f=await fixture(t),authority=await edit(f),prepared=await prepare(f,authority),input=commitInput(f,prepared);let lost=false
 const transactions={...f.transactions,async withPrincipalTransaction(...args){const result=await f.transactions.withPrincipalTransaction(...args);if(!lost){lost=true;throw Error('lost PPTX commit client acknowledgement')}return result}}
 const revisions=createRevisionService({transactions,objects:f.objects,files:f.files})
 await assert.rejects(()=>revisions.commitRevision(f.alice.token,input),/lost PPTX commit client acknowledgement/)
 const before=await state(f),saved=await f.revisions.commitRevision(f.alice.token,input)
 assert.deepEqual(await state(f),before);assert.equal(before.receipts,1);await assertReopened(f,saved)
})
test('real PPTX SQL receipt failure rolls back metadata and same prepared object retries',async t=>{
 const f=await fixture(t),authority=await edit(f),prepared=await prepare(f,authority),input=commitInput(f,prepared),before=await state(f)
 await f.ownerPool.query("CREATE FUNCTION reject_pptx_commit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'controlled PPTX receipt failure'; END$$; CREATE TRIGGER reject_pptx_commit BEFORE INSERT ON revision_commits FOR EACH ROW EXECUTE FUNCTION reject_pptx_commit()")
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,input),/controlled PPTX receipt failure/);assert.deepEqual(await state(f),before)
 await f.ownerPool.query('DROP TRIGGER reject_pptx_commit ON revision_commits')
 await assertReopened(f,await f.revisions.commitRevision(f.alice.token,input))
})
test('revoked session cannot commit real PPTX prepared bytes',async t=>{
 const f=await fixture(t),authority=await edit(f),prepared=await prepare(f,authority)
 await f.sessions.logout(f.alice.token)
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,commitInput(f,prepared)),{statusCode:401})
})
