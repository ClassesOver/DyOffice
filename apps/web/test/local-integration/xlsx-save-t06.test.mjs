import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import JSZip from 'jszip'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {s3Fixture} from '../helpers/s3.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {blankXlsxBuffer} from '../../../../packages/xlsx-gateway/src/gateway/csv-import-xlsx.ts'
import {applyCellEditsToXlsx,assertOnlyTouchedEntriesChanged} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway.ts'
// Trusted generated fixture only. This calls the existing pure library, NOT the
// systemd native job or a production fallback. No sandbox/OS claim is made.
const edits=[
 {sheetName:'Sheet1',row:0,column:0,writeValue:true,cell:{value:'Actual edit & value'},style:{bold:true}},
 {sheetName:'Sheet1',row:0,column:1,writeValue:true,cell:{value:42}},
 {sheetName:'Sheet1',row:0,column:2,writeValue:true,cell:{value:null,formula:'=B1*2'}},
]
async function fixture(t){
 const s3=await s3Fixture(t),f=await fileFixture(t,{buildApp:false,objectStore:s3.store})
 const zip=await JSZip.loadAsync(await blankXlsxBuffer());zip.file('customXml/unchanged.xml','<fixture>preserve me</fixture>')
 const original=await zip.generateAsync({type:'nodebuffer'}),initial=(await importFile(f,f.alice.token,original,'actual-edit.xlsx')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),editorId=randomUUID()
 const lease=await leases.acquireLease(f.alice.token,initial.fileId,{editorId})
 return {...f,initial,original,leases,revisions,editorId,lease}
}
async function edited(f){
 const source=await f.files.readFile(f.alice.token,f.initial.fileId,f.initial.revision)
 const result=await applyCellEditsToXlsx(source,edits)
 assertOnlyTouchedEntriesChanged(result)
 assert.ok(result.touchedEntries.includes('xl/worksheets/sheet1.xml'))
 assert.notDeepEqual(result.buffer,source)
 return result
}
async function prepare(f,bytes){
 const u=await f.revisions.stageUpload(f.alice.token,f.initial.fileId,{size:bytes.length,baseRevision:f.initial.revision,leaseEpoch:f.lease.leaseEpoch,editorId:f.editorId})
 await f.files.receiveUpload(f.alice.token,u.uploadId,bytes)
 return {fileId:f.initial.fileId,uploadId:u.uploadId,baseRevision:f.initial.revision,leaseEpoch:f.lease.leaseEpoch,idempotencyKey:randomUUID()}
}
async function state(f){return f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT (SELECT current_revision FROM files WHERE id=$1) head,(SELECT count(*)::int FROM file_revisions WHERE file_id=$1) versions,(SELECT count(*)::int FROM revision_commits WHERE file_id=$1) receipts,(SELECT count(*)::int FROM revision_outbox WHERE file_id=$1) events,(SELECT reserved_bytes::text FROM storage_accounts WHERE owner_id=$2) reserved,(SELECT stored_bytes::text FROM storage_accounts WHERE owner_id=$2) stored',[f.initial.fileId,f.alice.user.id])).rows[0])}
async function verifySaved(f,saved){
 const bytes=await f.files.readFile(f.alice.token,saved.fileId,saved.revision),zip=await JSZip.loadAsync(bytes,{checkCRC32:true})
 const sheet=await zip.file('xl/worksheets/sheet1.xml').async('string')
 assert.match(sheet,/<c r="A1"[^>]*t="inlineStr"><is><t xml:space="preserve">Actual edit &amp; value<\/t><\/is><\/c>/)
 assert.match(sheet,/<c r="B1"><v>42<\/v><\/c>/)
 assert.match(sheet,/<c r="C1"><f>B1\*2<\/f><\/c>/)
 assert.match(await zip.file('xl/styles.xml').async('string'),/<b\/>/)
 assert.equal(await zip.file('customXml/unchanged.xml').async('string'),'<fixture>preserve me</fixture>')
 assert.equal(bytes.length,saved.size)
 return bytes
}
test('actual XLSX text number formula and style edits pass real T06 and RustFS; exact replay adds no revision',async t=>{
 const f=await fixture(t),result=await edited(f),before=await state(f),input=await prepare(f,result.buffer)
 assert.equal((await state(f)).head,before.head)
 const saved=await f.revisions.commitRevision(f.alice.token,input)
 assert.deepEqual(await f.revisions.commitRevision(f.alice.token,input),saved)
 assert.deepEqual(await verifySaved(f,saved),result.buffer)
 const after=await state(f);assert.equal(after.versions,before.versions+1);assert.equal(after.receipts,1);assert.equal(after.events,1);assert.equal(after.reserved,'0')
})
test('actual XLSX output cannot stage after edit lease takeover',async t=>{
 const f=await fixture(t),result=await edited(f),before=await state(f)
 await f.leases.takeoverLease(f.alice.token,f.initial.fileId,{editorId:randomUUID(),expectedEpoch:f.lease.leaseEpoch})
 await assert.rejects(()=>prepare(f,result.buffer),e=>e.statusCode===409)
 assert.deepEqual(await state(f),before)
})
test('XLSX receipt insertion failure rolls back all metadata and original upload retries successfully',async t=>{
 const f=await fixture(t),result=await edited(f),input=await prepare(f,result.buffer),before=await state(f)
 await f.ownerPool.query("CREATE FUNCTION reject_xlsx_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'controlled XLSX receipt failure'; END$$; CREATE TRIGGER reject_xlsx_receipt BEFORE INSERT ON revision_commits FOR EACH ROW EXECUTE FUNCTION reject_xlsx_receipt()")
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,input),/controlled XLSX receipt failure/)
 assert.deepEqual(await state(f),before)
 await f.ownerPool.query('DROP TRIGGER reject_xlsx_receipt ON revision_commits')
 await verifySaved(f,await f.revisions.commitRevision(f.alice.token,input));assert.equal((await state(f)).receipts,1)
})
test('same XLSX bytes in another upload cannot replace the exact idempotent commit input',async t=>{
 const f=await fixture(t),result=await edited(f),first=await prepare(f,result.buffer),second=await prepare(f,result.buffer)
 const saved=await f.revisions.commitRevision(f.alice.token,first),before=await state(f)
 await assert.rejects(()=>f.revisions.commitRevision(f.alice.token,{...second,idempotencyKey:first.idempotencyKey}),e=>e.statusCode===409)
 assert.deepEqual(await state(f),before);assert.deepEqual(await f.revisions.commitRevision(f.alice.token,first),saved)
})
test('lost XLSX commit acknowledgement recovers the original receipt without re-editing or restaging',async t=>{
 const f=await fixture(t),result=await edited(f),input=await prepare(f,result.buffer)
 const transactions={...f.transactions,async withPrincipalTransaction(...args){await f.transactions.withPrincipalTransaction(...args);throw Error('lost XLSX acknowledgement after real commit')}}
 const unreliable=createRevisionService({transactions,objects:f.objects,files:f.files})
 await assert.rejects(()=>unreliable.commitRevision(f.alice.token,input),/lost XLSX acknowledgement/)
 const before=await state(f),saved=await f.revisions.commitRevision(f.alice.token,input)
 assert.equal(saved.revision,before.head);assert.equal(before.receipts,1);assert.deepEqual(await state(f),before);await verifySaved(f,saved)
})
