import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument,rgb} from 'pdf-lib'
import {PNG} from 'pngjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
import {readImageBitmap} from '../../../pdf/src/main/image-edit.ts'
const pixels=Buffer.from([220,30,20,255,30,210,40,128,40,30,220,0,240,190,20,64,180,20,210,192,20,190,210,255])
function imageData(channels,width=3,height=2){const png=new PNG({width,height});png.data.set(channels);return {mime:'image/png',base64:PNG.sync.write(png).toString('base64')}}
const image=imageData(pixels)
function bgra(channels){const result=Buffer.from(channels);for(let i=0;i<result.length;i+=4){result[i]=channels[i+2];result[i+2]=channels[i]}return result}
const near=(a,b)=>assert.ok(Math.abs(a-b)<.1,`${a} != ${b}`)
test('PDF image content stages and commits real alpha pixels, replaces without moving neighbors, and preserves source versions',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),page=doc.addPage([500,400])
 page.drawRectangle({x:0,y:0,width:500,height:400,color:rgb(.15,.3,.55)})
 page.drawText('Caption remains',{x:40,y:40,size:14,color:rgb(1,1,1)})
 const picture=await doc.embedPng(image.base64);page.drawImage(picture,{x:320,y:210,width:90,height:60})
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'image-content.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 let revision=source.revision
 const write=async operation=>{
  const staged=await pdf.stageImageContent(f.alice.token,source.fileId,{baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation})
  assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision)
  const saved=await revisions.commitRevision(f.alice.token,staged.commitInput)
  assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
  revision=saved.revision;return await f.files.readFile(f.alice.token,source.fileId,revision)
 }
 const initial=(await pdf.queryImages(f.alice.token,source.fileId,{revision})).images
 const inserted=await write({op:'insert_image',page:1,image,x:40,y:70,width:180,layer:'above_text'})
 let listed=(await pdf.queryImages(f.alice.token,source.fileId,{revision})).images
 assert.equal(listed.length,2);const added=listed.find(i=>Math.abs(i.x-40)<.1);assert.ok(added)
 near(added.y,70);near(added.width,180);near(added.height,120);assert.equal(added.layer,'above_text')
 assert.deepEqual(await readImageBitmap(inserted,0,[40,210,220,330],3,2),bgra(pixels))
 const replacementPixels=Buffer.from([20,230,180,96,230,40,180,255]),replacement=imageData(replacementPixels,2,1)
 const replaced=await write({op:'replace_image',page:1,image_number:added.image_number,image:replacement})
 const after=(await pdf.queryImages(f.alice.token,source.fileId,{revision})).images
 assert.deepEqual(after,listed)
 assert.deepEqual(await readImageBitmap(replaced,0,[40,210,220,330],2,1),bgra(replacementPixels))
 assert.deepEqual(after.find(i=>Math.abs(i.x-320)<.1),{...initial[0],image_number:after.find(i=>Math.abs(i.x-320)<.1).image_number})
 const base={baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation:{op:'insert_image',page:1,image}}
 await assert.rejects(pdf.stageImageContent(f.bob.token,source.fileId,base),e=>e.statusCode===404)
 await assert.rejects(pdf.stageImageContent(f.alice.token,source.fileId,{...base,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 await assert.rejects(pdf.stageImageContent(f.alice.token,source.fileId,{...base,operation:{op:'replace_image',page:1,image_number:99,image}}),e=>e.statusCode===400)
 await assert.rejects(pdf.stageImageContent(f.alice.token,source.fileId,{...base,operation:{...base.operation,image:{mime:'image/webp',base64:'UklGRg=='}}}),e=>e.statusCode===400)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await mkdir('/tmp/dyoffice-pdf-image-content-review',{recursive:true})
 await writeFile('/tmp/dyoffice-pdf-image-content-review/inserted.pdf',inserted);await writeFile('/tmp/dyoffice-pdf-image-content-review/replaced.pdf',replaced)
})
