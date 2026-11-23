import test from 'node:test'
import assert from 'node:assert/strict'
import {PDFDocument,PDFName,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib'
import {PNG} from 'pngjs'
import {isolatePdfImageResources} from '../server/src/pdf/isolate-image-resources.mjs'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
function streamText(context,contents){return (contents instanceof PDFArray?contents.asArray():[contents]).map(ref=>Buffer.from(context.lookup(ref) instanceof PDFRawStream?decodePDFRawStream(context.lookup(ref)).decode():context.lookup(ref).getContents()).toString('latin1')).join(' ')}
function imageRefs(doc){const result=[];function walk(contents,resources,seen=new Set()){
 const source=streamText(doc.context,contents),xo=resources.lookup(PDFName.of('XObject'))
 for(const [,name]of source.matchAll(/\/([^\s]+)\s+Do\b/g)){
  const ref=xo.get(PDFName.of(name)),object=doc.context.lookup(ref),type=String(object.dict.get(PDFName.of('Subtype')))
  if(type==='/Image')result.push(ref.toString())
  else if(type==='/Form'&&!seen.has(object)){walk(ref,object.dict.lookup(PDFName.of('Resources')),new Set(seen).add(object))}
 }
 }for(const page of doc.getPages())walk(page.node.Contents(),page.node.Resources());return result}
async function fixture(){const png=new PNG({width:3,height:2});png.data.set([220,30,20,255,30,210,40,128,40,30,220,0,240,190,20,64,180,20,210,192,20,190,210,255]);const doc=await PDFDocument.create(),image=await doc.embedPng(PNG.sync.write(png)),page=doc.addPage([400,300]);page.drawImage(image,{x:20,y:100,width:60,height:40});page.drawImage(image,{x:140,y:100,width:90,height:60});page.drawText('Keep /not-an-image Do literal',{x:10,y:20,size:10});return Buffer.from(await doc.save())}
test('each shared image drawing receives an independent resource without changing pixels or drawing state',async()=>{
 const bytes=await fixture(),before=await PDFDocument.load(bytes)
 assert.equal(new Set(imageRefs(before)).size,1)
 const isolated=await isolatePdfImageResources(bytes),after=await PDFDocument.load(isolated)
 assert.equal(imageRefs(after).length,2);assert.equal(new Set(imageRefs(after)).size,2)
 assert.deepEqual(await readPdfLeafObjects(isolated,true),await readPdfLeafObjects(bytes,true))
})
test('repeated nested Forms are isolated per occurrence while every native leaf stays identical',async()=>{
 const source=await PDFDocument.load(await fixture()),doc=await PDFDocument.create(),form=await doc.embedPage(source.getPage(0)),page=doc.addPage([700,600])
 page.drawPage(form,{x:20,y:30,xScale:.8,yScale:.9});page.drawPage(form,{x:350,y:250,xScale:.6,yScale:.7})
 const bytes=Buffer.from(await doc.save()),isolated=await isolatePdfImageResources(bytes),after=await PDFDocument.load(isolated)
 const refs=imageRefs(after);assert.equal(refs.length,4);assert.equal(new Set(refs).size,4)
 assert.deepEqual(await readPdfLeafObjects(isolated,true),await readPdfLeafObjects(bytes,true))
})
test('tokenizer ignores names and Do in comments, literals and hex strings; rejects unsafe inline images and cycles',async()=>{
 const doc=await PDFDocument.load(await fixture()),page=doc.getPage(0)
 const old=page.node.Contents();page.node.set(PDFName.of('Contents'),doc.context.obj([doc.context.register(doc.context.flateStream('% /missing Do\n(/missing Do (nested) \\) text) Tj\n<2f6d697373696e6720446f> Tj\n')), ...old.asArray()]))
 const bytes=Buffer.from(await doc.save());await isolatePdfImageResources(bytes)
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream('BI /W 1 /H 1 /CS /RGB /BPC 8 ID aaa EI')))
 await assert.rejects(isolatePdfImageResources(Buffer.from(await doc.save())),{code:'PDF_IMAGE_RESOURCE_UNSUPPORTED'})
})

test('bare image source exposes intrinsic soft-mask pixels without inherited opacity or blend',async()=>{
 const {createPdfImagePixelSource}=await import('../server/src/pdf/isolate-image-resources.mjs')
 const {readImageBitmap}=await import('../../pdf/src/main/image-edit.ts')
 const {rgb,BlendMode}=await import('pdf-lib')
 const png=new PNG({width:2,height:1});png.data.set([20,100,220,128,220,60,30,255])
 const doc=await PDFDocument.create(),p=doc.addPage([300,200]),im=await doc.embedPng(PNG.sync.write(png))
 p.drawRectangle({x:0,y:0,width:300,height:200,color:rgb(.2,.4,.6)})
 p.drawImage(im,{x:30,y:70,width:80,height:40,opacity:.4,blendMode:BlendMode.Multiply})
 const original=Buffer.from(await doc.save()),source=await createPdfImagePixelSource(original,0,0)
 assert.equal(source.width,2);assert.equal(source.height,1);assert.equal(source.rasterSafe,false)
 assert.deepEqual(await readImageBitmap(source.bytes,0,[0,0,2,1],2,1),Buffer.from([220,100,20,128,30,60,220,255]))
 await assert.rejects(createPdfImagePixelSource(original,0,1),{code:'PDF_IMAGE_RESOURCE_UNSUPPORTED'})
})

test('resource writer replaces only one shared nested occurrence and applies a crop matrix without reordering leaves',async()=>{
 const {replacePdfImagePixels,createPdfImagePixelSource}=await import('../server/src/pdf/isolate-image-resources.mjs')
 const {readImageBitmap}=await import('../../pdf/src/main/image-edit.ts')
 const source=await PDFDocument.load(await fixture()),doc=await PDFDocument.create(),form=await doc.embedPage(source.getPage(0)),page=doc.addPage([700,600])
 page.drawPage(form,{x:20,y:30,xScale:.8,yScale:.9});page.drawPage(form,{x:350,y:250,xScale:.6,yScale:.7})
 const bytes=Buffer.from(await doc.save()),before=await readPdfLeafObjects(bytes,true)
 const pixels={width:2,height:1,bgra:Buffer.from([20,80,160,128,210,40,90,255])}
 const replaced=await replacePdfImagePixels(bytes,0,0,pixels)
 const after=await readPdfLeafObjects(replaced,true)
 assert.equal(after.length,before.length)
 for(let i=1;i<after.length;i++)assert.deepEqual(after[i],before[i])
 assert.deepEqual(after[0].matrix,before[0].matrix);assert.notEqual(after[0].image,before[0].image)
 const intrinsic=await createPdfImagePixelSource(replaced,0,0)
 assert.deepEqual(await readImageBitmap(intrinsic.bytes,0,[0,0,2,1],2,1),pixels.bgra)
 const cropped=await replacePdfImagePixels(replaced,0,0,pixels,[.5,0,0,.5,.25,.25]),crop=await readPdfLeafObjects(cropped,true)
 for(let i=1;i<crop.length;i++)assert.deepEqual(crop[i],after[i])
 assert.ok(Math.abs(crop[0].matrix[0]-after[0].matrix[0]*.5)<.01)
 assert.ok(Math.abs(crop[0].matrix[4]-(after[0].matrix[4]+after[0].matrix[0]*.25))<.01)
})

test('resource writer preserves clipping, opacity, blend and marked-content source instructions',async()=>{
 const {replacePdfImagePixels}=await import('../server/src/pdf/isolate-image-resources.mjs')
 const {BlendMode}=await import('pdf-lib')
 const doc=await PDFDocument.load(await fixture()),page=doc.getPage(0),im=await doc.embedPng(PNG.sync.write(Object.assign(new PNG({width:1,height:1}),{data:Buffer.from([30,70,200,255])})))
 page.drawImage(im,{x:20,y:200,width:40,height:40,opacity:.4,blendMode:BlendMode.Multiply})
 const old=page.node.Contents(),wrapped=doc.context.register(doc.context.flateStream('q\n20 100 30 20 re W n\n/Artifact BMC\n'))
 page.node.set(PDFName.of('Contents'),doc.context.obj([wrapped,...old.asArray(),doc.context.register(doc.context.flateStream('EMC\nQ\n'))]))
 const bytes=Buffer.from(await doc.save()),reloaded=await PDFDocument.load(bytes),beforeText=streamText(reloaded.context,reloaded.getPage(0).node.Contents())
 const after=await PDFDocument.load(await replacePdfImagePixels(bytes,0,0,{width:1,height:1,bgra:Buffer.from([100,40,220,192])})),text=streamText(after.context,after.getPage(0).node.Contents())
 const scrub=s=>s.replace(/\/[^\s]+\s+Do\b/g,'/IMAGE Do')
 assert.equal(scrub(text),scrub(beforeText))
 const oldGs=page.node.Resources().lookup(PDFName.of('ExtGState')),newGs=after.getPage(0).node.Resources().lookup(PDFName.of('ExtGState'))
 assert.equal(newGs.toString(),oldGs.toString())
})

test('resource isolation refuses recursive Forms and keeps escaped resource names valid',async()=>{
 const doc=await PDFDocument.load(await fixture()),page=doc.getPage(0),resources=page.node.Resources(),xs=resources.lookup(PDFName.of('XObject'))
 const [oldKey,ref]=xs.entries()[0]
 xs.set(PDFName.of('Im age'),ref)
 const source=streamText(doc.context,page.node.Contents()).replaceAll(oldKey.toString(),'/Im#20age')
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(source)))
 const bytes=Buffer.from(await doc.save()),out=await isolatePdfImageResources(bytes)
 assert.deepEqual(await readPdfLeafObjects(out,true),await readPdfLeafObjects(bytes,true))
 const cycle=doc.context.flateStream('/Loop Do',{Type:'XObject',Subtype:'Form',BBox:[0,0,1,1]})
 const cycleRef=doc.context.register(cycle);cycle.dict.set(PDFName.of('Resources'),doc.context.obj({XObject:{Loop:cycleRef}}));xs.set(PDFName.of('Loop'),cycleRef)
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream('/Loop Do')))
 await assert.rejects(isolatePdfImageResources(Buffer.from(await doc.save())),{code:'PDF_IMAGE_RESOURCE_UNSUPPORTED'})
})

test('literal hex-looking hash sequences in image resource names are decoded exactly once',async()=>{
 const doc=await PDFDocument.load(await fixture()),page=doc.getPage(0),resources=page.node.Resources(),xs=resources.lookup(PDFName.of('XObject'))
 const [,ref]=xs.entries()[0];xs.set(PDFName.of('Im#2320'),ref)
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream('q 50 0 0 50 0 0 cm /Im#2320 Do Q')))
 const bytes=Buffer.from(await doc.save()),before=await readPdfLeafObjects(bytes,true)
 assert.equal(before.length,1)
 assert.deepEqual(await readPdfLeafObjects(await isolatePdfImageResources(bytes),true),before)
 const {createPdfImagePixelSource}=await import('../server/src/pdf/isolate-image-resources.mjs')
 assert.equal((await createPdfImagePixelSource(bytes,0,0)).width,3)
})

test('content-array boundaries preserve native comments and token separation',async()=>{
 const doc=await PDFDocument.load(await fixture()),page=doc.getPage(0),xs=page.node.Resources().lookup(PDFName.of('XObject'))
 const [,ref]=xs.entries()[0];xs.set(PDFName.of('Im'),ref)
 page.node.set(PDFName.of('Contents'),doc.context.obj([doc.context.register(doc.context.flateStream('% comment')),doc.context.register(doc.context.flateStream('q 50 0 0 50 0 0 cm /Im Do Q'))]))
 let bytes=Buffer.from(await doc.save())
 assert.equal((await readPdfLeafObjects(bytes,true)).length,0)
 assert.deepEqual(await readPdfLeafObjects(await isolatePdfImageResources(bytes),true),[])
 page.node.set(PDFName.of('Contents'),doc.context.obj([doc.context.register(doc.context.flateStream('q 50 0 0 50 0 0 cm /I')),doc.context.register(doc.context.flateStream('m Do Q'))]))
 bytes=Buffer.from(await doc.save())
 assert.equal((await readPdfLeafObjects(bytes,true)).length,0)
 await assert.rejects(isolatePdfImageResources(bytes),{code:'PDF_IMAGE_RESOURCE_UNSUPPORTED'})
 page.node.set(PDFName.of('Contents'),doc.context.obj([doc.context.register(doc.context.flateStream('q 50 0 0 50 0 0 cm /Im')),doc.context.register(doc.context.flateStream('Do Q'))]))
 bytes=Buffer.from(await doc.save())
 assert.equal((await readPdfLeafObjects(bytes,true)).length,1)
 assert.deepEqual(await readPdfLeafObjects(await isolatePdfImageResources(bytes),true),await readPdfLeafObjects(bytes,true))
 const {createPdfImagePixelSource}=await import('../server/src/pdf/isolate-image-resources.mjs')
 assert.equal((await createPdfImagePixelSource(bytes,0,0)).width,3)
})


test('a commented-out image before the actual image never shifts the editable ordinal',async()=>{
 const {createPdfImagePixelSource,replacePdfImagePixels}=await import('../server/src/pdf/isolate-image-resources.mjs')
 const doc=await PDFDocument.load(await fixture()),page=doc.getPage(0),xs=page.node.Resources().lookup(PDFName.of('XObject'))
 const [,ref]=xs.entries()[0];xs.set(PDFName.of('Im'),ref)
 page.node.set(PDFName.of('Contents'),doc.context.obj([doc.context.register(doc.context.flateStream('% comment')),doc.context.register(doc.context.flateStream('q 10 0 0 10 0 0 cm /Im Do Q\nq 20 0 0 20 30 0 cm /Im Do Q'))]))
 const bytes=Buffer.from(await doc.save()),before=await readPdfLeafObjects(bytes,true)
 assert.equal(before.length,1);assert.deepEqual(before[0].matrix,[20,0,0,20,30,0])
 assert.deepEqual(await readPdfLeafObjects(await isolatePdfImageResources(bytes),true),before)
 assert.equal((await createPdfImagePixelSource(bytes,0,0)).width,3)
 await assert.rejects(createPdfImagePixelSource(bytes,0,1),{code:'PDF_IMAGE_RESOURCE_UNSUPPORTED'})
 const after=await readPdfLeafObjects(await replacePdfImagePixels(bytes,0,0,{width:1,height:1,bgra:Buffer.from([30,90,210,255])}),true)
 assert.equal(after.length,1);assert.deepEqual(after[0].matrix,before[0].matrix)
})
