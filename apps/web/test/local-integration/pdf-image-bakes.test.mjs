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
function imageData(channels,width,height){const png=new PNG({width,height});png.data.set(channels);return PNG.sync.write(png)}
const near=(a,b)=>assert.ok(Math.abs(a-b)<.1,`${a} != ${b}`)
const pixels=Buffer.alloc(4*4*4);for(let y=0;y<4;y++)for(let x=0;x<4;x++)pixels.set([40+x*50,30+y*50,60,255],(y*4+x)*4)
const logo=Buffer.alloc(6*6*4,255);for(let y=1;y<5;y++)for(let x=1;x<5;x++)logo.set([30,50,70,255],(y*6+x)*4);logo.set([255,255,255,255],(2*6+2)*4)
const bgra=rgba=>{const out=Buffer.from(rgba);for(let i=0;i<rgba.length;i+=4){out[i]=rgba[i+2];out[i+2]=rgba[i]}return out}
test('PDF pixel edits flip, crop, fade and remove a background on committed source versions without touching neighbors',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),page=doc.addPage([500,400])
 page.drawRectangle({x:0,y:0,width:500,height:400,color:rgb(.15,.3,.55)})
 page.drawText('Caption remains',{x:40,y:40,size:14,color:rgb(1,1,1)})
 const picture=await doc.embedPng(imageData(pixels,4,4)),second=await doc.embedPng(imageData(logo,6,6))
 page.drawImage(picture,{x:40,y:260,width:80,height:80});page.drawImage(second,{x:250,y:100,width:120,height:120})
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'image-bakes.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 let revision=source.revision
 const list=async()=> (await pdf.queryImages(f.alice.token,source.fileId,{revision})).images
 const write=async operation=>{
  const staged=await pdf.stageImageBakes(f.alice.token,source.fileId,{baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation})
  assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision)
  const saved=await revisions.commitRevision(f.alice.token,staged.commitInput)
  assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved)
  revision=saved.revision;return await f.files.readFile(f.alice.token,source.fileId,revision)
 }
 const initial=await list(),flipped=await write({op:'flip_image',page:1,image_number:1,axis:'horizontal'})
 const flippedPixels=Buffer.alloc(pixels.length);for(let y=0;y<4;y++)for(let x=0;x<4;x++)pixels.copy(flippedPixels,(y*4+x)*4,(y*4+3-x)*4,(y*4+4-x)*4)
 assert.deepEqual(await readImageBitmap(flipped,0,[40,260,120,340],4,4),bgra(flippedPixels))
 assert.deepEqual(await list(),initial)
 const cropped=await write({op:'crop_image',page:1,image_number:1,left:.25,top:.25}),croppedPixels=Buffer.alloc(3*3*4)
 for(let y=0;y<3;y++)for(let x=0;x<3;x++)flippedPixels.copy(croppedPixels,(y*3+x)*4,((y+1)*4+x+1)*4,((y+1)*4+x+2)*4)
 assert.deepEqual(await readImageBitmap(cropped,0,[60,260,120,320],3,3),bgra(croppedPixels))
 let listed=await list();near(listed[0].x,60);near(listed[0].y,80);near(listed[0].width,60);near(listed[0].height,60);assert.deepEqual(listed[1],initial[1])
 const faded=await write({op:'set_image_opacity',page:1,image_number:1,opacity:.5}),fadedPixels=bgra(croppedPixels)
 for(let i=3;i<fadedPixels.length;i+=4)fadedPixels[i]=128
 assert.deepEqual(await readImageBitmap(faded,0,[60,260,120,320],3,3),fadedPixels)
 const cutout=await write({op:'remove_image_background',page:1,image_number:2,tolerance:0}),cut=await readImageBitmap(cutout,0,[250,100,370,220],6,6)
 assert.equal(cut[3],0);assert.equal(cut[(1*6+1)*4+3],255);assert.equal(cut[(2*6+2)*4+3],255)
 assert.deepEqual(await readImageBitmap(cutout,0,[60,260,120,320],3,3),fadedPixels)
 const invisible=await write({op:'set_image_opacity',page:1,image_number:1,opacity:0})
 const invisiblePixels=await readImageBitmap(invisible,0,[60,260,120,320],3,3);for(let i=3;i<invisiblePixels.length;i+=4)assert.equal(invisiblePixels[i],0)
 assert.equal((await list()).length,2)
 await write({op:'flip_image',page:1,image_number:1,axis:'vertical'})
 const base={baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operation:{op:'flip_image',page:1,image_number:1,axis:'horizontal'}}
 await assert.rejects(pdf.stageImageBakes(f.bob.token,source.fileId,base),e=>e.statusCode===404)
 await assert.rejects(pdf.stageImageBakes(f.alice.token,source.fileId,{...base,leaseEpoch:lease.leaseEpoch+1}),e=>e.statusCode===409)
 await assert.rejects(pdf.stageImageBakes(f.alice.token,source.fileId,{...base,operation:{op:'crop_image',page:1,image_number:1,left:.6,right:.4}}),e=>e.statusCode===400)
 assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision)
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 await mkdir('/tmp/dyoffice-pdf-image-bakes-review',{recursive:true});await writeFile('/tmp/dyoffice-pdf-image-bakes-review/flipped.pdf',flipped);await writeFile('/tmp/dyoffice-pdf-image-bakes-review/cropped.pdf',cropped);await writeFile('/tmp/dyoffice-pdf-image-bakes-review/faded.pdf',faded);await writeFile('/tmp/dyoffice-pdf-image-bakes-review/cutout.pdf',cutout)
})
