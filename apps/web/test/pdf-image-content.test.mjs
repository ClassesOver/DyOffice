import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,degrees,PDFName} from 'pdf-lib'
import {PNG} from 'pngjs'
import {createPdfImageContentJob,decodePdfImage,validatePdfImageContentOperation} from '../server/src/pdf/image-content-job.mjs'
import {createIsolatedPdfImageContentJob} from '../server/src/pdf/image-content-isolated.mjs'
import {queryPdfImages} from '../server/src/pdf/image-edits-job.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
import {readImageBitmap} from '../../pdf/src/main/image-edit.ts'
import {pdfInsertFormState} from '../server/src/pdf/insert-form-integrity.mjs'
const pixels=Buffer.from([200,40,10,255,20,160,80,128,70,90,220,0,10,80,230,64,90,130,20,192,255,40,120,255])
const png=new PNG({width:3,height:2});png.data.set(pixels)
const image={base64:PNG.sync.write(png).toString('base64'),mime:'image/png'}
const replacementPng=new PNG({width:4,height:3});for(let i=0;i<replacementPng.data.length;i+=4)replacementPng.data.set([30+i,210-i,90,[0,64,128,255][(i/4)%4]],i)
const replacementImage={base64:PNG.sync.write(replacementPng).toString('base64'),mime:'image/png'}
const command=operation=>JSON.stringify({version:1,action:'imageContent',operation})
async function fixture(rotation=0,unit=1){const d=await PDFDocument.create(),p=d.addPage([400,360]);p.setCropBox(10,20,360,320);p.setRotation(degrees(rotation));p.node.set(PDFName.of('UserUnit'),d.context.obj(unit));p.drawText('Image anchor',{x:40,y:260,size:12});const im=await d.embedPng(image.base64);p.drawImage(im,{x:200,y:70,width:80,height:40});return Buffer.from(await d.save())}
test('insert content uses a Node decoder, preserves every alpha and supports isolated processing',async()=>{
 const input=await fixture()
 for(const job of [createPdfImageContentJob(),createIsolatedPdfImageContentJob()]){
  const result=await job.execute(input,command({op:'insert_image',page:1,image,x:30,y:40,width:90})),images=await queryPdfImages(result.bytes)
  assert.equal(images.length,2);const inserted=images.find(i=>Math.abs(i.x-30)<.1);assert.ok(inserted);assert.equal(inserted.layer,'below_text');assert.equal(inserted.width,90);assert.equal(inserted.height,60)
  const decoded=decodePdfImage(image),bitmap=await readImageBitmap(result.bytes,0,[40,240,130,300],3,2);assert.deepEqual(bitmap,decoded.bgra)
 }
})
test('insert placement defaults, anchors, fit and rotated/UserUnit geometry match PC',async()=>{
 for(const rot of [0,90,180,270]){
  const input=await fixture(rot,2),result=await createPdfImageContentJob().execute(input,command({op:'insert_image',page:1,image,x:40,y:50,width:120,layer:'above_text'})),added=(await queryPdfImages(result.bytes)).find(i=>Math.abs(i.x-40)<.1&&Math.abs(i.y-50)<.1)
  assert.ok(added);assert.ok(Math.abs(added.width-120)<.1);assert.equal(added.layer,'above_text')
 }
 const input=await fixture(),center=await createPdfImageContentJob().execute(input,command({op:'insert_image',page:1,image})),natural=(await readPdfLeafObjects(center.bytes)).find(i=>i.type===3&&i.bounds[2]-i.bounds[0]<3)
 assert.ok(natural);assert.ok(Math.abs(natural.bounds[2]-natural.bounds[0]-2.25)<.1);assert.ok(Math.abs(natural.bounds[0]-10-(360-2.25)/2)<.1)
 for(const placement of ['above','below','left','right'])assert.equal((await queryPdfImages((await createPdfImageContentJob().execute(input,command({op:'insert_image',page:1,image,anchor_text:'Image anchor',placement,width:50}))).bytes)).length,2)
 await assert.rejects(createPdfImageContentJob().execute(input,command({op:'insert_image',page:1,image,anchor_text:'not present'})),{code:'PDF_TEXT_ANCHOR_NOT_FOUND'})
})
test('replace preserves source footprint and order including nested Forms',async()=>{
 const original=await fixture(),source=await PDFDocument.load(original),d=await PDFDocument.create(),p=d.addPage([500,500]);p.drawPage(await d.embedPage(source.getPage(0)),{x:30,y:40,xScale:.8,yScale:.9});p.drawText('Keep outside',{x:10,y:15,size:10})
 const bytes=Buffer.from(await d.save()),before=await queryPdfImages(bytes),result=await createPdfImageContentJob().execute(bytes,command({op:'replace_image',page:1,image_number:1,image:replacementImage}));const after=await queryPdfImages(result.bytes);assert.equal(after.length,before.length);for(const key of ['x','y','width','height'])assert.ok(Math.abs(after[0][key]-before[0][key])<.01);assert.equal(after[0].layer,before[0].layer)
 const beforeLeaf=await readPdfLeafObjects(bytes,true),afterLeaf=await readPdfLeafObjects(result.bytes,true),beforeImage=beforeLeaf.find(i=>i.type===3),afterImage=afterLeaf.find(i=>i.type===3);assert.notEqual(beforeImage.image,afterImage.image);for(let i=0;i<6;i++)assert.ok(Math.abs(beforeImage.matrix[i]-afterImage.matrix[i])<.01);assert.deepEqual(beforeLeaf.filter(i=>i.type!==3),afterLeaf.filter(i=>i.type!==3));const rendered=await readImageBitmap(result.bytes,0,afterImage.bounds,4,3),expected=decodePdfImage(replacementImage).bgra;for(let i=0;i<rendered.length;i+=4){assert.equal(rendered[i+3],expected[i+3]);if(expected[i+3])assert.deepEqual(rendered.subarray(i,i+3),expected.subarray(i,i+3))}
 await assert.rejects(createPdfImageContentJob().execute(bytes,command({op:'replace_image',page:1,image_number:2,image})),{code:'PDF_IMAGE_NOT_FOUND'})
})
test('content codec rejects spoofed MIME, invalid base64, oversized pixels and webp; cancellation refuses writes',async()=>{
 for(const bad of [{...image,mime:'image/jpeg'},{...image,base64:image.base64+'!'},{base64:Buffer.from('RIFFtestWEBP').toString('base64'),mime:'image/webp'}])assert.throws(()=>decodePdfImage(bad))
 const huge=Buffer.from(image.base64,'base64');huge.writeUInt32BE(100000,16);assert.throws(()=>decodePdfImage({...image,base64:huge.toString('base64')}))
 for(const op of [{op:'insert_image',page:0,image},{op:'replace_image',page:1,image_number:0,image},{op:'insert_image',page:1,image,url:'https://example.com'},{op:'insert_image',page:1,image,width:0}])assert.throws(()=>validatePdfImageContentOperation(op))
 const abort=new AbortController();abort.abort();await assert.rejects(createIsolatedPdfImageContentJob().execute(await fixture(),command({op:'insert_image',page:1,image}),abort.signal),{code:'ABORTED'})
})
test('JPEG RGB, grayscale, progressive and CMYK decode to actual saved RGB pixels without Electron',async()=>{
 const {readFile}=await import('node:fs/promises'),fixtures=JSON.parse(await readFile(new URL('./fixtures/pdf-image-content-codecs.json',import.meta.url),'utf8'))
 for(const [name,jpeg]of Object.entries(fixtures)){
  const decoded=decodePdfImage(jpeg);assert.equal(decoded.width,8,name);assert.equal(decoded.height,6,name);for(let i=3;i<decoded.bgra.length;i+=4)assert.equal(decoded.bgra[i],255,name)
  const output=await createPdfImageContentJob().execute(await fixture(),command({op:'insert_image',page:1,image:jpeg,x:10,y:20,width:80}));assert.equal((await queryPdfImages(output.bytes)).length,2)
 }
})
test('isolated content accepts images above one MiB and preserves pixels; active cancellation kills work',async()=>{
 const noisy=new PNG({width:600,height:500});let seed=42
 for(let i=0;i<noisy.data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;noisy.data[i]=seed>>>24}
 const encoded=PNG.sync.write(noisy),large={mime:'image/png',base64:encoded.toString('base64')};assert.ok(encoded.length>1024*1024)
 const input=await fixture(),output=await createIsolatedPdfImageContentJob().execute(input,command({op:'insert_image',page:1,image:large,x:10,y:10,width:120}));assert.equal((await queryPdfImages(output.bytes)).length,2)
 const controller=new AbortController(),pending=createIsolatedPdfImageContentJob().execute(input,command({op:'insert_image',page:1,image:large}),controller.signal);setTimeout(()=>controller.abort(),10);await assert.rejects(pending,{code:'ABORTED'})
})
test('isolated image insertion preserves a filled form field and its appearance',async()=>{
 const doc=await PDFDocument.load(await fixture()),field=doc.getForm().createTextField('ReviewStatus')
 field.setText('Reviewed');field.addToPage(doc.getPage(0),{x:250,y:35,width:100,height:25})
 const input=Buffer.from(await doc.save())
 const {bytes}=await createIsolatedPdfImageContentJob().execute(input,command({op:'insert_image',page:1,image,x:12,y:20,width:80}))
 assert.equal((await queryPdfImages(bytes)).length,2)
 assert.equal(pdfInsertFormState(await PDFDocument.load(bytes)),pdfInsertFormState(await PDFDocument.load(input)))
})
test('content refuses signed, encrypted and XFA source documents before mutation',async()=>{
 const input=await fixture(),signed=await PDFDocument.load(input);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}))
 await assert.rejects(createPdfImageContentJob().execute(Buffer.from(await signed.save()),command({op:'insert_image',page:1,image})),{code:'SIGNATURE_EDIT_REFUSED'})
 const form=await PDFDocument.load(input)
 form.catalog.set(PDFName.of('AcroForm'),form.context.obj({Fields:[],XFA:form.context.register(form.context.stream('<xdp/>'))}))
 await assert.rejects(createPdfImageContentJob().execute(Buffer.from(await form.save({updateFieldAppearances:false})),command({op:'insert_image',page:1,image})),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(input);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}));await assert.rejects(createPdfImageContentJob().execute(Buffer.from(await encrypted.save()),command({op:'insert_image',page:1,image})),{code:'PASSWORD'})
})
test('replace isolates shared images across pages and nested Forms while preserving clipping and opacity/blend state',async()=>{
 const {BlendMode,pushGraphicsState,popGraphicsState,rectangle,clip,endPath}=await import('pdf-lib'),{renderImageOccurrence}=await import('../../pdf/src/main/image-edit.ts')
 const d=await PDFDocument.create(),p=d.addPage([400,300]),im=await d.embedPng(image.base64)
 p.pushOperators(pushGraphicsState(),rectangle(50,80,60,80),clip(),endPath());p.drawImage(im,{x:30,y:70,width:120,height:80,opacity:.4,blendMode:BlendMode.Multiply});p.pushOperators(popGraphicsState());p.drawImage(im,{x:220,y:80,width:60,height:40});d.addPage([400,300]).drawImage(im,{x:40,y:60,width:100,height:70})
 const original=Buffer.from(await d.save()),leaves=await readPdfLeafObjects(original,true),target=leaves[0],number=(await queryPdfImages(original)).find(i=>Math.abs(i.x-30)<.1).image_number,result=await createPdfImageContentJob().execute(original,command({op:'replace_image',page:1,image_number:number,image:replacementImage})),after=await readPdfLeafObjects(result.bytes,true)
 assert.equal(after.length,leaves.length);for(let index=1;index<after.length;index++)assert.deepEqual(after[index],leaves[index])
 const expected=await PDFDocument.create(),page=expected.addPage([400,300]),newImage=await expected.embedPng(replacementImage.base64)
 page.pushOperators(pushGraphicsState(),rectangle(50,80,60,80),clip(),endPath());page.drawImage(newImage,{x:30,y:70,width:120,height:80,opacity:.4,blendMode:BlendMode.Multiply});page.pushOperators(popGraphicsState())
 const actualPixels=await renderImageOccurrence(result.bytes,0,target.bounds,360,240,[3,0,0,-3,-90,450]),expectedPixels=await renderImageOccurrence(Buffer.from(await expected.save()),0,target.bounds,360,240,[3,0,0,-3,-90,450]);assert.deepEqual(actualPixels,expectedPixels)
 const base=await PDFDocument.load(original),nested=await PDFDocument.create(),nestedPage=nested.addPage([500,500]),embedded=await nested.embedPage(base.getPage(0));nestedPage.drawPage(embedded,{x:20,y:30,xScale:.8,yScale:.9});nestedPage.drawPage(embedded,{x:200,y:250,xScale:.5,yScale:.5});const nestedBytes=Buffer.from(await nested.save()),beforeNested=await readPdfLeafObjects(nestedBytes,true)
 const changed=await createPdfImageContentJob().execute(nestedBytes,command({op:'replace_image',page:1,image_number:1,image:replacementImage})),afterNested=await readPdfLeafObjects(changed.bytes,true);assert.equal(afterNested.length,beforeNested.length);assert.equal(afterNested.filter((leaf,index)=>leaf.image!==beforeNested[index].image).length,1)
})
