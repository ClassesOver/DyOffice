import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileFixture} from '../helpers/files.mjs'
test('services-only fixture keeps real PostgreSQL roles without constructing an HTTP application',async t=>{
 const f=await fileFixture(t,{buildApp:false})
 assert.equal(f.app,undefined)
 assert.deepEqual((await f.businessPool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],{current_user:f.names.business,rolsuper:false,rolbypassrls:false})
})
import {randomUUID} from 'node:crypto'
import {PDFDocument} from 'pdf-lib'
import {importFile} from '../helpers/files.mjs'
import {s3Fixture} from '../helpers/s3.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfRotationJob} from '../../server/src/pdf/rotation-job.mjs'
import {createPdfSavePreparation} from '../../server/src/pdf/save-preparation.mjs'
import {objectKey} from '../../server/src/modules/files/queries.ts'
const request=JSON.stringify({version:1,action:'rotatePages',operations:[{page:1,degrees:90}]})
async function fixture(t,options={}){
 const s3=await s3Fixture(t),f=await fileFixture(t,{buildApp:false,objectStore:s3.store,...options}),doc=await PDFDocument.create();doc.addPage([200,100]);
 const initial=(await importFile(f,f.alice.token,Buffer.from(await doc.save()),'sample.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),editorId=randomUUID()
 const lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 const input={token:f.alice.token,fileId:initial.fileId,baseRevision:initial.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),request}
 const preparation=createPdfSavePreparation({files:f.files,leases,revisions,processor:createPdfRotationJob()})
 return {...f,s3,initial,leases,revisions,input,preparation}
}
async function state(f){return f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT current_revision FROM files WHERE id=$1) head,(SELECT count(*)::int FROM file_revisions) versions,(SELECT count(*)::int FROM revision_commits) receipts,(SELECT count(*)::int FROM revision_outbox) events,(SELECT reserved_bytes::text FROM storage_accounts WHERE owner_id=$2) reserved',[f.initial.fileId,f.alice.user.id])).rows[0])}
async function outputKey(f,uploadId){return f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async(c,p)=>objectKey(p,(await c.query('SELECT revision_id FROM uploads WHERE id=$1',[uploadId])).rows[0].revision_id))}
test('real PDF rotation persists through PostgreSQL T06 and RustFS with exact receipt replay and reopen',async t=>{
 const f=await fixture(t),before=await state(f),prepared=await f.preparation.prepare(f.input)
 assert.equal((await state(f)).head,before.head)
 const saved=await f.revisions.commitRevision(f.alice.token,prepared.commitInput)
 assert.deepEqual(await f.revisions.commitRevision(f.alice.token,prepared.commitInput),saved)
 const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision),pdf=await PDFDocument.load(bytes)
 assert.equal(pdf.getPage(0).getRotation().angle,90);assert.equal(saved.sha256,prepared.sha256);assert.equal(bytes.length,prepared.size)
 const after=await state(f);assert.equal(after.versions,before.versions+1);assert.equal(after.receipts,1);assert.equal(after.events,1);assert.equal(after.reserved,'0')
})
test('committed PDF save with lost client confirmation recovers using original commitInput without rerunning rotation',async t=>{
 const f=await fixture(t),prepared=await f.preparation.prepare(f.input);let lost=false
 const wrapped={...f.transactions,async withPrincipalTransaction(...args){const result=await f.transactions.withPrincipalTransaction(...args);if(!lost){lost=true;throw Error('injected lost client acknowledgement after real committed transaction')}return result}}
 const revisions=createRevisionService({transactions:wrapped,objects:f.objects,files:f.files})
 await assert.rejects(()=>revisions.commitRevision(f.alice.token,prepared.commitInput),/lost client acknowledgement/)
 const committed=await state(f),saved=await f.revisions.commitRevision(f.alice.token,prepared.commitInput)
 assert.equal(saved.revision,committed.head);assert.deepEqual(await state(f),committed);assert.equal(committed.receipts,1)
 const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision);assert.equal((await PDFDocument.load(bytes)).getPage(0).getRotation().angle,90)
})
test('real RustFS object corruption refuses commit and leaves head receipts and outbox unchanged',async t=>{
 const f=await fixture(t),prepared=await f.preparation.prepare(f.input),before=await state(f)
 await f.s3.corrupt(await outputKey(f,prepared.commitInput.uploadId),Buffer.from('corrupted test output'))
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,prepared.commitInput))
 assert.deepEqual(await state(f),before)
})
test('real SQL commit failure rolls back PDF metadata while immutable staged object supports exact retry',async t=>{
 const f=await fixture(t),prepared=await f.preparation.prepare(f.input),before=await state(f)
 await f.ownerPool.query("CREATE FUNCTION reject_pdf_commit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'controlled PDF receipt failure'; END$$; CREATE TRIGGER reject_pdf_commit BEFORE INSERT ON revision_commits FOR EACH ROW EXECUTE FUNCTION reject_pdf_commit()")
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,prepared.commitInput),/controlled PDF receipt failure/)
 assert.deepEqual(await state(f),before)
 await f.ownerPool.query('DROP TRIGGER reject_pdf_commit ON revision_commits')
 const saved=await f.revisions.commitRevision(f.alice.token,prepared.commitInput)
 assert.equal((await PDFDocument.load(await f.files.readFile(f.alice.token,saved.fileId,saved.revision))).getPage(0).getRotation().angle,90)
 assert.equal((await state(f)).receipts,1)
})
test('lease takeover and session revocation fence already prepared real PDF output',async t=>{
 const f=await fixture(t),prepared=await f.preparation.prepare(f.input),before=await state(f)
 await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.input.leaseEpoch})
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,prepared.commitInput))
 assert.deepEqual(await state(f),before)
 await f.sessions.logout(f.alice.token)
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,prepared.commitInput),e=>e.statusCode===401)
})
test('actual RustFS publication followed by lost acknowledgement retains ambiguous upload and never commits',async t=>{
 let lose=false,published
 const f=await fixture(t,{wrapObjects:base=>({...base,async putImmutable(key,bytes){const ref=await base.putImmutable(key,bytes);if(lose){lose=false;published=ref;throw Error('lost acknowledgement after actual S3 publication')}return ref}})})
 const before=await state(f);lose=true
 await assert.rejects(()=>f.preparation.prepare(f.input),/lost acknowledgement/)
 assert.ok(published);await f.s3.store.verifyObject(published)
 const after=await state(f);assert.equal(after.head,before.head);assert.equal(after.receipts,0);assert.equal(after.events,0);assert.ok(BigInt(after.reserved)>0n)
 const uploads=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query("SELECT state FROM uploads WHERE file_id=$1 AND kind='revision'",[f.initial.fileId])).rows)
 assert.deepEqual(uploads,[{state:'receiving'}])
})
