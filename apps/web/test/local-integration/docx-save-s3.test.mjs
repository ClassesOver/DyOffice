import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {parseDocx,saveDocx} from '../../../../packages/docx-engine/src/index.ts'
import {buildDocx} from '../../../../packages/docx-engine/tests/helpers/build-docx.ts'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {s3Fixture} from '../helpers/s3.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
// Trusted generated input, real serialization and T06. No HTTP route or OS isolation claim.
const text=b=>(b.runs??[]).map(r=>r.text??'').join('')
async function editedFixture(){
 const original=Buffer.from(await buildDocx({
  bodyXml:'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>Keep me</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>CellKeep</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  headerXml:'<w:p><w:r><w:t>HeaderKeep</w:t></w:r></w:p>',
  footerXml:'<w:p><w:r><w:t>FooterKeep</w:t></w:r></w:p>'}))
 const parsed=await parseDocx(original),target=parsed.blocks.find(b=>text(b)==='Hello');assert.ok(target)
 const output=Buffer.from(await saveDocx(parsed,parsed.blocks.filter(b=>!b.hidden&&b.docxIndex!=null).map(b=>b===target
  ?{kind:'generated',docxIndex:b.docxIndex,block:{type:b.type,rawPPr:b.rawPPr,runs:b.runs.map(r=>({...r,text:'Edited 世界 & <safe>'}))}}
  :{kind:'original',docxIndex:b.docxIndex})))
 return {original,output}
}
async function verifyEdit(original,output){
 const before=await parseDocx(original),after=await parseDocx(output)
 assert.equal(text(before.blocks[0]),'Hello');assert.equal(text(after.blocks[0]),'Edited 世界 & <safe>')
 assert.match(after.blocks[0].runs[0].rawRPr,/<w:b\b/)
 assert.ok(after.blocks.some(b=>text(b)==='Keep me'))
 assert.equal(after.blocks.find(b=>b.type==='table').originalXml,before.blocks.find(b=>b.type==='table').originalXml)
 const a=await JSZip.loadAsync(original),b=await JSZip.loadAsync(output)
 for(const path of ['word/styles.xml','word/header1.xml','word/footer1.xml'])assert.deepEqual(await b.file(path).async('uint8array'),await a.file(path).async('uint8array'))
}
async function setup(t){
 const s3=await s3Fixture(t),f=await fileFixture(t,{buildApp:false,objectStore:s3.store});assert.equal(f.app,undefined)
 const bytes=await editedFixture(),initial=(await importFile(f,f.alice.token,bytes.original)).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 const upload=await revisions.stageUpload(f.alice.token,initial.fileId,{size:bytes.output.length,baseRevision:initial.revision,editorId,leaseEpoch:lease.leaseEpoch})
 await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes.output)
 const commit={fileId:initial.fileId,uploadId:upload.uploadId,baseRevision:initial.revision,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID()}
 return {...f,...bytes,initial,leases,revisions,lease,commit}
}
async function state(f){return f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query(`SELECT (SELECT current_revision FROM files WHERE id=$1) head,(SELECT count(*)::int FROM file_revisions) versions,(SELECT count(*)::int FROM revision_commits) receipts,(SELECT count(*)::int FROM revision_outbox) events`,[f.initial.fileId])).rows[0])}
test('trusted DOCX real engine edits text and preserves fixture formatting and ancillary parts',async()=>{
 const {original,output}=await editedFixture();assert.notDeepEqual(output,original);await verifyEdit(original,output)
})
test('real DOCX edit survives PostgreSQL T06 and RustFS reopen with exact replay and original history',async t=>{
 const f=await setup(t),before=await state(f);assert.equal(before.head,f.initial.revision)
 const saved=await f.revisions.commitRevision(f.alice.token,f.commit),after=await state(f)
 assert.deepEqual(await f.revisions.commitRevision(f.alice.token,f.commit),saved);assert.deepEqual(await state(f),after)
 assert.equal(after.versions,before.versions+1);assert.equal(after.receipts,before.receipts+1);assert.equal(after.events,before.events+1)
 assert.equal(saved.sha256,createHash('sha256').update(f.output).digest('hex'))
 const reopened=await f.files.readFile(f.alice.token,saved.fileId,saved.revision);assert.deepEqual(reopened,f.output);await verifyEdit(f.original,reopened)
 assert.deepEqual(await f.files.readFile(f.alice.token,saved.fileId,f.initial.revision),f.original)
 await assert.rejects(f.files.readFile(f.bob.token,saved.fileId,saved.revision),e=>e.statusCode===404)
 assert.equal((await f.files.usage(f.alice.token)).reservedBytes,0)
})
test('real DOCX staged output cannot bypass owner or superseded lease at T06 commit',async t=>{
 const f=await setup(t),before=await state(f)
 await assert.rejects(f.revisions.commitRevision(f.bob.token,f.commit),e=>e.statusCode===404);assert.deepEqual(await state(f),before)
 await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.lease.leaseEpoch})
 await assert.rejects(f.revisions.commitRevision(f.alice.token,f.commit),e=>e.statusCode===409);assert.deepEqual(await state(f),before)
 assert.deepEqual(await f.files.readFile(f.alice.token,f.initial.fileId,f.initial.revision),f.original)
})
