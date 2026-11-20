import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {createPdfStampsJob} from '../../server/src/pdf/stamps-job.mjs'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
async function fixture(prefix,count){const d=await PDFDocument.create();for(let i=1;i<=count;i++){const p=d.addPage([450+i*10,600]);p.setRotation(degrees(i%4*90));p.setCropBox(10,20,400,550);p.drawText(prefix+' '+i,{x:30,y:300,size:14})}return Buffer.from(await d.save())}
const stamp=async(bytes,operation)=>(await createPdfStampsJob().execute(bytes,JSON.stringify({version:1,action:'stamps',operation}))).bytes
const text=async bytes=>(await readPdfLeafObjects(bytes)).filter(o=>o.type===1).map(o=>o.text).join('|')
test('cross-file PDF replacement stages without publishing and commits source pages in PC order with revision history',async t=>{
 const f=await fileFixture(t,{buildApp:false})
 let targetBytes=await fixture('Target',4),sourceBytes=await fixture('Source',2)
 targetBytes=await stamp(targetBytes,{op:'set_watermark',text:'Target managed'});targetBytes=await stamp(targetBytes,{op:'set_header_footer',page_number:true})
 sourceBytes=await stamp(sourceBytes,{op:'set_watermark',text:'Source managed'})
 const file=(await importFile(f,f.alice.token,targetBytes,'target.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,file.fileId,{editorId})
 const input={baseRevision:file.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),pages:[3,1]}
 await assert.rejects(pdf.stageReplacePages(f.bob.token,file.fileId,input,sourceBytes),e=>e.statusCode===404)
 await assert.rejects(pdf.stageReplacePages(f.alice.token,file.fileId,{...input,leaseEpoch:lease.leaseEpoch+1},sourceBytes),e=>e.statusCode===409)
 const staged=await pdf.stageReplacePages(f.alice.token,file.fileId,input,sourceBytes)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
 const bytes=await f.files.readFile(f.alice.token,file.fileId,saved.revision),items=await readPdfLeafObjects(bytes),d=await PDFDocument.load(bytes),src=await PDFDocument.load(sourceBytes),dst=await PDFDocument.load(targetBytes)
 assert.equal(d.getPageCount(),4)
 for(const [index,body]of ['Source 1','Source 2','Target 2','Target 4'].entries()){
  const strings=items.filter(o=>o.type===1&&o.page===index).map(o=>o.text).join('|');assert.ok(strings.includes(body));assert.ok(strings.includes('Target managed'));assert.ok(strings.includes(`${index+1} / 4`))
  const expected=index<2?src.getPage(index):dst.getPage(index===2?1:3),actual=d.getPage(index)
  assert.deepEqual(actual.getMediaBox(),expected.getMediaBox());assert.deepEqual(actual.getCropBox(),expected.getCropBox());assert.equal(actual.getRotation().angle,expected.getRotation().angle)
 }
 assert.equal((await text(bytes)).match(/Source managed/g)?.length,2)
 let removed=await stamp(bytes,{op:'set_watermark',text:''});removed=await stamp(removed,{op:'set_header_footer'})
 assert.doesNotMatch(await text(removed),/Target managed|\d \/ 4/);assert.equal((await text(removed)).match(/Source managed/g)?.length,2)
 for(const page of (await PDFDocument.load(removed)).getPages())assert.equal(page.node.has(PDFName.of('DyOfficeStamps')),false)
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),targetBytes)
 await assert.rejects(pdf.stageReplacePages(f.alice.token,file.fileId,{...input,idempotencyKey:randomUUID()},sourceBytes),e=>e.statusCode===409)
})
test('PDF page insertion stages and commits at the selected position without changing the old revision',async t=>{
 const f=await fileFixture(t,{buildApp:false}),targetBytes=await fixture('Target',3),sourceBytes=await fixture('Imported',2)
 const file=(await importFile(f,f.alice.token,targetBytes,'insert-target.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,file.fileId,{editorId})
 const input={baseRevision:file.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),afterPageIndex:0}
 await assert.rejects(pdf.stageReplacePages(f.bob.token,file.fileId,input,sourceBytes),e=>e.statusCode===404)
 await assert.rejects(pdf.stageReplacePages(f.alice.token,file.fileId,{...input,afterPageIndex:3},sourceBytes),e=>e.statusCode===400&&e.detail==='INVALID_PDF_INSERT_PAGES')
 const staged=await pdf.stageReplacePages(f.alice.token,file.fileId,input,sourceBytes)
 assert.equal((await f.files.openFile(f.alice.token,file.fileId)).file.revision,file.revision)
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput)
 const bytes=await f.files.readFile(f.alice.token,file.fileId,saved.revision)
 assert.equal((await PDFDocument.load(bytes)).getPageCount(),5)
 assert.deepEqual((await text(bytes)).split('|'),['Target 1','Imported 1','Imported 2','Target 2','Target 3'])
 assert.deepEqual(await f.files.readFile(f.alice.token,file.fileId,file.revision),targetBytes)
})
