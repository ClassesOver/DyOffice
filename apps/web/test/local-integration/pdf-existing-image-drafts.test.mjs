import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PDFDocument,degrees} from 'pdf-lib'
import {PNG} from 'pngjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {catalog} from '../../server/src/pdf/image-edits-job.mjs'
import {readImageSource} from '../../../pdf/src/main/image-edit.ts'
import {readPdfLeafObjects} from '../../../pdf/src/main/text-edit.ts'
const image=color=>{const p=new PNG({width:4,height:4});for(let i=0;i<p.data.length;i+=4)p.data.set(color,i);return {mime:'image/png',base64:PNG.sync.write(p).toString('base64')}}
for(const kind of ['delete-sort','replace-crop'])test('existing image pending batch '+kind+' queries read-only and commits once with real PG/RLS',{timeout:60000},async t=>{
 const f=await fileFixture(t,{buildApp:false}),d=await PDFDocument.create(),p=d.addPage([500,600]);p.drawText('Source stays',{x:300,y:560});for(const [i,c]of [[255,0,0,255],[0,255,0,255],[0,0,255,255]].entries())p.drawImage(await d.embedPng(Buffer.from(image(c).base64,'base64')),{x:40,y:500-i*100,width:40,height:40})
 const original=Buffer.from(await d.save()),source=(await importFile(f,f.alice.token,original,'existing-drafts.pdf')).file,leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files});let stages=0
 const pdf=createPdfService({files:f.files,leases,revisions:{...revisions,async stageUpload(...args){stages++;return revisions.stageUpload(...args)}}})
 const operation=kind==='delete-sort'?{texts:[],images:[],imageEdits:[{op:'delete_image',page:1,image_number:1},{op:'transform_image',page:1,image_number:2,x:180,y:400},{op:'set_image_opacity',page:1,image_number:3,opacity:.8}]}:{texts:[{page:1,text:'Pending mixed',x:250,y:300}],images:[{page:1,image:image([255,255,0,255]),x:300,y:350,width:20}],imageEdits:[{op:'replace_image',page:1,image_number:1,image:image([0,255,255,255])},{op:'crop_image',page:1,image_number:2,left:.25}]}
 for(const token of [f.bob.token,f.adminSigned.token])await assert.rejects(pdf.queryDraftInserts(token,source.fileId,{revision:source.revision,operation}),e=>e.statusCode===404)
 const preview=await pdf.queryDraftInserts(f.alice.token,source.fileId,{revision:source.revision,operation});assert.equal(preview.pages.length,1);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision);assert.equal(stages,0)
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId}),input={baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation}
 await assert.rejects(pdf.stageDraftInserts(f.bob.token,source.fileId,input),e=>e.statusCode===404);await assert.rejects(pdf.stageDraftInserts(f.alice.token,source.fileId,{...input,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 const duplicate={...operation,imageEdits:[operation.imageEdits[0],operation.imageEdits[0]]};await assert.rejects(pdf.stageDraftInserts(f.alice.token,source.fileId,{...input,operation:duplicate}),e=>e.statusCode===400);assert.equal(stages,0)
 const staged=await pdf.stageDraftInserts(f.alice.token,source.fileId,input);assert.equal(stages,1);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const saved=await revisions.commitRevision(f.alice.token,staged.commitInput);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved);assert.equal(stages,1)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,saved.revision),entries=(await catalog(bytes)).entries,objects=await readPdfLeafObjects(bytes)
 const read=async x=>{const e=entries.find(e=>Math.abs(e.image.x-x)<.1);assert.ok(e);return readImageSource(bytes,0,e.ref.rect)}
 assert.ok(objects.some(o=>o.text==='Source stays'))
 if(kind==='delete-sort'){assert.equal(entries.length,2);assert.deepEqual([...(await read(180)).bgra.subarray(0,4)],[0,255,0,255]);assert.equal((await read(40)).bgra[3],204)}
 else{assert.equal(entries.length,4);const first=entries.find(e=>e.image.y===60),crop=entries.find(e=>e.image.y===160);assert.deepEqual([...(await readImageSource(bytes,0,first.ref.rect)).bgra.subarray(0,4)],[255,255,0,255]);assert.equal((await readImageSource(bytes,0,crop.ref.rect)).width,3);assert.ok(objects.some(o=>o.text==='Pending mixed'))}
 await assert.rejects(pdf.queryDraftInserts(f.alice.token,source.fileId,{revision:source.revision,operation}),e=>e.statusCode===409);await assert.rejects(pdf.stageDraftInserts(f.alice.token,source.fileId,input),e=>e.statusCode===409)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
})

test('nested affine image draft previews and saves once with text, then reopens from PG revision',{timeout:60000},async t=>{
 const f=await fileFixture(t,{buildApp:false}),inner=await PDFDocument.create(),page=inner.addPage([500,500]),picture=new PNG({width:4,height:3})
 for(let i=0;i<picture.data.length;i+=4)picture.data.set([20+i*3,210-i*2,40+i,255],i)
 page.drawImage(await inner.embedPng(PNG.sync.write(picture)),{x:200,y:200,width:100,height:75,rotate:degrees(30),xSkew:degrees(20),opacity:.4});page.drawText('Affine source',{x:30,y:30})
 const wrapper=await PDFDocument.create(),outer=wrapper.addPage([600,600]);outer.drawPage(await wrapper.embedPage((await PDFDocument.load(await inner.save())).getPage(0)),{x:40,y:50,xScale:.8,yScale:.9})
 const original=Buffer.from(await wrapper.save()),source=(await importFile(f,f.alice.token,original,'nested-affine.pdf')).file,leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files});let stages=0
 const pdf=createPdfService({files:f.files,leases,revisions:{...revisions,async stageUpload(...args){stages++;return revisions.stageUpload(...args)}}}),operation={texts:[{page:1,text:'Affine saved',x:100,y:100}],images:[],imageEdits:[{op:'crop_image',page:1,image_number:1,left:.25}]}
 const preview=await pdf.queryDraftInserts(f.alice.token,source.fileId,{revision:source.revision,operation});assert.equal(preview.pages.length,1);assert.equal(stages,0);assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,source.revision)
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId}),staged=await pdf.stageDraftInserts(f.alice.token,source.fileId,{baseRevision:source.revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation}),saved=await revisions.commitRevision(f.alice.token,staged.commitInput)
 assert.equal(stages,1);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
 const reopened=await f.files.openFile(f.alice.token,source.fileId);assert.equal(reopened.file.revision,saved.revision)
 const bytes=await f.files.readFile(f.alice.token,source.fileId,reopened.file.revision),before=(await catalog(original)).entries[0].image,after=(await catalog(bytes)).entries[0].image,objects=await readPdfLeafObjects(bytes)
 const rasterWidth=Math.ceil(before.width*3),cut=Math.round(rasterWidth*.25)/rasterWidth
 assert.ok(Math.abs(after.width-before.width*(1-cut))<.02,JSON.stringify({before,after,cut}));assert.ok(Math.abs(after.height-before.height)<.02);assert.ok(Math.abs(after.x-(before.x+before.width*cut))<.02)
 assert.ok(objects.some(o=>o.text==='Affine source'));assert.ok(objects.some(o=>o.text==='Affine saved'));assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
})
