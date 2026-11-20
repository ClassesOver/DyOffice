import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,PDFName,degrees} from 'pdf-lib'
import {PNG} from 'pngjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
test('image drafts geometry/raster previews do not write; one mixed commit preserves original history and authority',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create();for(const angle of [0,90,180,270]){const p=doc.addPage([500,600]);p.setCropBox(20,30,450,540);p.setRotation(degrees(angle));p.node.set(PDFName.of('UserUnit'),doc.context.obj(2));p.drawText('Original',{x:50,y:330,size:14})}
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'draft-images.pdf')).file,leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions}),png=new PNG({width:3,height:2});png.data.fill(255)
 const image={base64:PNG.sync.write(png).toString('base64'),mime:'image/png'},images=[1,2,3,4].map(page=>({page,image,x:50,y:50,width:100,height:40,layer:'below_text'})),texts=[1,2,3,4].map(page=>({page,text:'Pending text',x:50,y:55})),operation={texts,images}
 for(const token of [f.bob.token,f.adminSigned.token]){await assert.rejects(pdf.queryImageInserts(token,source.fileId,{revision:source.revision,operation:images[0]}),e=>e.statusCode===404);await assert.rejects(pdf.queryDraftInserts(token,source.fileId,{revision:source.revision,operation}),e=>e.statusCode===404)}
 const before=(await f.files.openFile(f.alice.token,source.fileId)).file,geometry=await pdf.queryImageInserts(f.alice.token,source.fileId,{revision:source.revision,operation:images[0]});assert.equal(geometry.image.width,100);assert.equal(geometry.image.height,40)
 const rendered=await pdf.queryDraftInserts(f.alice.token,source.fileId,{revision:source.revision,operation});assert.equal(rendered.pages.length,4);for(const page of rendered.pages){const pixels=PNG.sync.read(Buffer.from(page.png,'base64'));assert.equal(pixels.width,Math.ceil(page.width));assert.equal(pixels.height,Math.ceil(page.height))}
 assert.deepEqual((await f.files.openFile(f.alice.token,source.fileId)).file,before);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId}),input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:'mixed-draft-save-001',operation}
 await assert.rejects(pdf.stageDraftInserts(f.bob.token,source.fileId,input),e=>e.statusCode===404);await assert.rejects(pdf.stageDraftInserts(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 const staged=await pdf.stageDraftInserts(f.alice.token,source.fileId,input);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const receipt=await revisions.commitRevision(f.alice.token,staged.commitInput);assert.notEqual(receipt.revision,source.revision);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),receipt)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,receipt.revision),leaves=await readPdfLeafObjects(bytes);assert.equal(leaves.filter(o=>o.type===3).length,4);assert.equal(leaves.filter(o=>o.type===1&&o.text?.trim()==='Pending text').length,4);assert.equal(leaves.filter(o=>o.type===1&&o.text?.trim()==='Original').length,4);assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await assert.rejects(pdf.queryDraftInserts(f.alice.token,source.fileId,{revision:source.revision,operation}),e=>e.statusCode===409)
})
