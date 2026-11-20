import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {PDFDocument} from 'pdf-lib'
import {PNG} from 'pngjs'
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'
import {fileFixture,importFile} from '../helpers/files.mjs'
import {createLeaseService} from '../../server/src/modules/leases/service.ts'
import {createRevisionService} from '../../server/src/modules/revisions/service.ts'
import {createPdfService} from '../../server/src/modules/pdf/service.ts'
const bitmap=new PNG({width:80,height:40});for(let y=0;y<40;y++)for(let x=0;x<80;x++){const i=(y*80+x)*4;bitmap.data[i]=x<40?200:30;bitmap.data[i+1]=y<20?60:180;bitmap.data[i+2]=80;bitmap.data[i+3]=255}const png=PNG.sync.write(bitmap)
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<.1,`${actual} != ${expected}`)
test('PDF image listing and edits authorize exact revisions and preserve other content through transform, rotate and delete',async t=>{
 const f=await fileFixture(t,{buildApp:false}),doc=await PDFDocument.create(),page=doc.addPage([500,400]),image=await doc.embedPng(png)
 page.drawImage(image,{x:40,y:260,width:100,height:50});page.drawImage(image,{x:300,y:100,width:60,height:60});page.drawText('Caption remains',{x:40,y:40,size:14})
 const original=Buffer.from(await doc.save()),source=(await importFile(f,f.alice.token,original,'images.pdf')).file
 const leases=createLeaseService({transactions:f.transactions}),revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files}),pdf=createPdfService({files:f.files,leases,revisions})
 await assert.rejects(pdf.queryImages(f.bob.token,source.fileId,{revision:source.revision}),error=>error.statusCode===404)
 const catalog=await pdf.queryImages(f.alice.token,source.fileId,{revision:source.revision});assert.equal(catalog.revision,source.revision);assert.equal(catalog.images.length,2)
 const first=catalog.images[0];assert.equal(first.image_number,1);near(first.x,40);near(first.y,90);near(first.width,100);near(first.height,50)
 const editorId=randomUUID(),lease=await leases.acquireLease(f.alice.token,source.fileId,{editorId})
 let revision=source.revision
 const write=async operations=>{
  const input={baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operations}
  const staged=await pdf.stageImageEdits(f.alice.token,source.fileId,input)
  assert.equal((await f.files.openFile(f.alice.token,source.fileId)).file.revision,revision)
  const saved=await revisions.commitRevision(f.alice.token,staged.commitInput);assert.deepEqual(await revisions.commitRevision(f.alice.token,staged.commitInput),saved);revision=saved.revision
  return (await pdf.queryImages(f.alice.token,source.fileId,{revision})).images
 }
 const base={baseRevision:revision,editorId,leaseEpoch:lease.leaseEpoch,idempotencyKey:randomUUID(),operations:[{op:'delete_image',page:1,image_number:99}]}
 await assert.rejects(pdf.stageImageEdits(f.alice.token,source.fileId,base),error=>error.statusCode===400)
 await assert.rejects(pdf.stageImageEdits(f.alice.token,source.fileId,{...base,leaseEpoch:lease.leaseEpoch+1}),error=>error.statusCode===409)
 const transformed=await write([{op:'transform_image',page:1,image_number:1,x:70,y:80,width:120,layer:'above_text'}])
 near(transformed[0].x,70);near(transformed[0].y,80);near(transformed[0].width,120);near(transformed[0].height,60);assert.equal(transformed[0].layer,'above_text');assert.deepEqual(transformed[1],catalog.images[1])
 const rotated=await write([{op:'rotate_image',page:1,image_number:1,direction:'cw'}])
 near(rotated[0].x,100);near(rotated[0].y,50);near(rotated[0].width,60);near(rotated[0].height,120)
 const movedBytes=await f.files.readFile(f.alice.token,source.fileId,revision)
 const remaining=await write([{op:'delete_image',page:1,image_number:1}]);assert.equal(remaining.length,1);near(remaining[0].x,300);near(remaining[0].y,240)
 const task=getDocument({data:Uint8Array.from(await f.files.readFile(f.alice.token,source.fileId,revision)),disableFontFace:true,useSystemFonts:true})
 try{assert.match((await (await (await task.promise).getPage(1)).getTextContent()).items.map(item=>item.str??'').join(''),/Caption remains/)}finally{await task.destroy()}
 assert.deepEqual(await f.files.readFile(f.alice.token,source.fileId,source.revision),original)
 assert.deepEqual((await pdf.queryImages(f.alice.token,source.fileId,{revision:source.revision})).images,catalog.images)
 await mkdir('/tmp/dyoffice-pdf-image-review',{recursive:true});await writeFile('/tmp/dyoffice-pdf-image-review/rotated.pdf',movedBytes)
})
