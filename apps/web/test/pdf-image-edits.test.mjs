import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,degrees,rgb} from 'pdf-lib'
import {createPdfImageEditsJob,createPdfImageQueryJob,queryPdfImages,validatePdfImageEditOperations} from '../server/src/pdf/image-edits-job.mjs'
import {createIsolatedPdfImageEditsJob,createIsolatedPdfImageQueryJob} from '../server/src/pdf/image-edits-isolated.mjs'
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DwHwyBNBAAAFRNB/8GxGIYAAAAAElFTkSuQmCC'
const command=operations=>JSON.stringify({version:1,action:'imageEdits',operations})
async function fixture(rotation=0,userUnit=1){const doc=await PDFDocument.create(),page=doc.addPage([500,450]),image=await doc.embedPng(PNG);page.setCropBox(20,30,450,390);page.setRotation(degrees(rotation));page.node.set(PDFName.of('UserUnit'),doc.context.obj(userUnit));page.drawImage(image,{x:55,y:300,width:80,height:40});page.drawText('Keep the source text',{x:45,y:220,size:14});page.drawImage(image,{x:250,y:100,width:60,height:90});page.drawRectangle({x:50,y:80,width:70,height:40,color:rgb(.2,.5,.7)});return Buffer.from(await doc.save())}
test('image list uses native enumeration and stable display ordering without importing Electron',async()=>{
 const input=await fixture(),images=await queryPdfImages(input);assert.equal(images.length,2);assert.deepEqual(images[0],{page:1,image_number:1,x:35,y:80,width:80,height:40,layer:'below_text'});assert.equal(images[1].layer,'above_text')
 for(const job of [createPdfImageQueryJob(),createIsolatedPdfImageQueryJob()]){const result=await job.execute(input,JSON.stringify({version:1,action:'imageQuery',operations:[]}));assert.deepEqual(JSON.parse(result.bytes),{images})}
})
test('image transform honors aspect ratio and PC fit/clamp, explicit layer and same-source batch numbering',async()=>{
 const input=await fixture(),copy=Buffer.from(input),operations=[{op:'transform_image',page:1,image_number:1,width:120,x:70,y:110,layer:'above_text'},{op:'delete_image',page:1,image_number:2}]
 for(const job of [createPdfImageEditsJob(),createIsolatedPdfImageEditsJob()]){const result=await job.execute(input,command(operations)),images=await queryPdfImages(result.bytes);assert.deepEqual(images,[{page:1,image_number:1,x:70,y:110,width:120,height:60,layer:'above_text'}])}
 assert.deepEqual(input,copy)
 const fitted=await createPdfImageEditsJob().execute(input,command([{op:'transform_image',page:1,image_number:1,width:10000,x:-99,y:99999}]))
 const image=(await queryPdfImages(fitted.bytes)).find(image=>Math.abs(image.width-450)<.1);assert.ok(image);assert.equal(image.x,0);assert.ok(Math.abs(image.y-165)<.1)
})
test('image clockwise rotation swaps footprint around center and preserves pixels for every page rotation/UserUnit',async()=>{
 for(const rotation of [0,90,180,270]){
  const input=await fixture(rotation,2),before=await queryPdfImages(input),first=before[0],result=await createPdfImageEditsJob().execute(input,command([{op:'rotate_image',page:1,image_number:1,direction:'cw'}])),images=await queryPdfImages(result.bytes)
  const after=images.find(image=>Math.abs(image.x+image.width/2-(first.x+first.width/2))<.1&&Math.abs(image.y+image.height/2-(first.y+first.height/2))<.1);assert.ok(after);assert.ok(Math.abs(after.width-first.height)<.1);assert.ok(Math.abs(after.height-first.width)<.1)
 }
})
test('image delete removes precisely the selected object and refuses ambiguous/repeated source targets',async()=>{
 const input=await fixture(),result=await createPdfImageEditsJob().execute(input,command([{op:'delete_image',page:1,image_number:1}]));assert.equal((await queryPdfImages(result.bytes)).length,1)
 await assert.rejects(createPdfImageEditsJob().execute(input,command([{op:'rotate_image',page:1,image_number:1},{op:'delete_image',page:1,image_number:1}])),{code:'PDF_IMAGE_TARGET_OVERLAP'})
 const doc=await PDFDocument.load(input),image=await doc.embedPng(PNG);doc.getPage(0).drawImage(image,{x:55,y:300,width:80,height:40})
 await assert.rejects(createPdfImageEditsJob().execute(Buffer.from(await doc.save()),command([{op:'delete_image',page:1,image_number:1}])),{code:'PDF_IMAGE_TARGET_AMBIGUOUS'})
 for(const patch of [{width:0},{image_number:0},{page:101},{layer:'back'},{direction:'45'},{image:'data'},{x:'10'}])assert.throws(()=>validatePdfImageEditOperations([{op:'transform_image',page:1,image_number:1,...patch}]))
})

test('nested Form image transforms and deletion retain sibling text, paths and other pixels',async()=>{
 const source=await PDFDocument.load(await fixture()),middle=await PDFDocument.create(),mid=middle.addPage([500,450]);mid.drawPage(await middle.embedPage(source.getPage(0)),{x:10,y:20,xScale:.9,yScale:.9})
 const doc=await PDFDocument.create(),page=doc.addPage([600,600]);page.drawPage(await doc.embedPage((await PDFDocument.load(await middle.save())).getPage(0)),{x:40,y:70,xScale:.8,yScale:.8});page.drawText('Outside source template',{x:25,y:40,size:12})
 const input=Buffer.from(await doc.save()),listed=await queryPdfImages(input);assert.equal(listed.length,2)
 const changed=await createPdfImageEditsJob().execute(input,command([{op:'transform_image',page:1,image_number:1,x:250,y:150,width:90}]))
 assert.ok((await queryPdfImages(changed.bytes)).some(image=>Math.abs(image.x-250)<.1&&Math.abs(image.width-90)<.1))
 const deleted=await createPdfImageEditsJob().execute(input,command([{op:'delete_image',page:1,image_number:1}]))
 assert.equal((await queryPdfImages(deleted.bytes)).length,1)
})

test('image query rejects oversized catalogs without truncation and permits read-only signed/forms',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([500,500]),image=await doc.embedPng(PNG)
 for(let i=0;i<1001;i++)page.drawImage(image,{x:(i%25)*15,y:Math.floor(i/25)*10,width:5,height:5})
 await assert.rejects(queryPdfImages(Buffer.from(await doc.save())),{code:'PDF_EDIT_LIMIT'})
 const source=await PDFDocument.load(await fixture());source.getForm().createTextField('ReadOnlyForm');source.context.register(source.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}));const signed=Buffer.from(await source.save())
 assert.equal((await queryPdfImages(signed)).length,2)
 await assert.rejects(createPdfImageEditsJob().execute(signed,command([{op:'delete_image',page:1,image_number:1}])),{code:'SIGNATURE_EDIT_REFUSED'})
})

test('image edits refuse encrypted inputs and terminate cancelled isolated jobs',async()=>{
 const input=await fixture(),doc=await PDFDocument.load(input);doc.context.trailerInfo.Encrypt=doc.context.register(doc.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}))
 const encrypted=Buffer.from(await doc.save());await assert.rejects(queryPdfImages(encrypted),{code:'PASSWORD'});await assert.rejects(createPdfImageEditsJob().execute(encrypted,command([{op:'delete_image',page:1,image_number:1}])),{code:'PASSWORD'})
 const controller=new AbortController(),pending=createIsolatedPdfImageEditsJob().execute(input,command([{op:'rotate_image',page:1,image_number:1}]),controller.signal);controller.abort();await assert.rejects(pending,{code:'ABORTED'})
})
