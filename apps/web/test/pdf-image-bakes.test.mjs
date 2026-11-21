import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {PDFDocument,PDFName,BlendMode,degrees,rgb,pushGraphicsState,popGraphicsState,rectangle,clip,endPath} from 'pdf-lib'
import {PNG} from 'pngjs'
import {createPdfImageBakesJob,validatePdfImageBakeOperation} from '../server/src/pdf/image-bakes-job.mjs'
import {createIsolatedPdfImageBakesJob} from '../server/src/pdf/image-bakes-isolated.mjs'
import {catalog} from '../server/src/pdf/image-edits-job.mjs'
import {queryPdfImages} from '../server/src/pdf/image-edits-job.mjs'
import {readImageSource} from '../../pdf/src/main/image-edit.ts'
import {readPdfLeafObjects} from '../../pdf/src/main/text-edit.ts'
import {pdfInsertFormState} from '../server/src/pdf/insert-form-integrity.mjs'
const source=new PNG({width:4,height:3});for(let i=0;i<source.data.length;i+=4)source.data.set([20+i*3,210-i*2,40+i,[64,128,192,255][i/4%4]],i)
const png=PNG.sync.write(source),command=operation=>JSON.stringify({version:1,action:'imageBakes',operation})
const near=(a,b)=>a.every((value,index)=>Math.abs(value-b[index])<.01)
async function fixture({pageRotation=0,turn=0,mirror=false,unit=1,nested=false,angle=turn,skew=0,opacity=1}={}){
 const d=await PDFDocument.create(),p=d.addPage([500,500]),im=await d.embedPng(png)
 p.drawImage(im,{x:250,y:200,width:mirror?-100:100,height:75,rotate:degrees(angle),xSkew:degrees(skew),opacity});p.drawText('Keep this caption',{x:30,y:60,size:14});p.drawImage(im,{x:30,y:90,width:40,height:30});p.drawRectangle({x:20,y:20,width:20,height:20,color:rgb(.3,.6,.8)})
 let bytes=await d.save()
 for(let level=0;level<Number(nested);level++){const a=await PDFDocument.create(),page=a.addPage([600,600]);page.drawPage(await a.embedPage((await PDFDocument.load(bytes)).getPage(0)),{x:40,y:50,xScale:.8,yScale:.9});page.drawText('Outside form '+level,{x:20,y:10,size:10});bytes=await a.save()}
 const final=await PDFDocument.load(bytes),page=final.getPage(0);page.setCropBox(10,15,nested?570:470,nested?570:470);page.setRotation(degrees(pageRotation));page.node.set(PDFName.of('UserUnit'),final.context.obj(unit));return Buffer.from(await final.save())
}
async function selected(bytes){const leaves=await readPdfLeafObjects(bytes,true),item=leaves.filter(i=>i.type===3).sort((a,b)=>(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1])-(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1]))[0],entries=(await catalog(bytes)).entries;const target=entries.find(entry=>near(entry.ref.rect,item.bounds))?.image;assert.ok(item);assert.ok(target);return {leaves,item,number:target.image_number,pixels:await readImageSource(bytes,0,item.bounds)}}
function sameNeighbors(before,after){const a=before.leaves.filter(i=>i!==before.item),b=after.leaves.filter(i=>i!==after.item);assert.equal(a.length,b.length);for(let i=0;i<a.length;i++){assert.equal(a[i].image,b[i].image);assert.equal(a[i].text,b[i].text);assert.equal(a[i].font,b[i].font);assert.ok(near(a[i].matrix,b[i].matrix));assert.ok(near(a[i].bounds,b[i].bounds))}}
test('display flips map every object quarter turn/mirror and page Rotate to the correct intrinsic axis',async()=>{
 for(const pageRotation of [0,90,180,270])for(const turn of [0,90,180,270])for(const mirror of [false,true]){
  const bytes=await fixture({pageRotation,turn,mirror,unit:2}),before=await selected(bytes)
  for(const axis of ['horizontal','vertical']){
   const result=await createPdfImageBakesJob().execute(bytes,command({op:'flip_image',page:1,image_number:before.number,axis})),after=await selected(result.bytes);sameNeighbors(before,after);assert.ok(near(before.item.matrix,after.item.matrix))
   // A quarter turn swaps the intrinsic horizontal and vertical display axes.
   const horizontal=(pageRotation+turn)%180===0,flipX=axis==='horizontal'?horizontal:!horizontal
   const {width:w,height:h,bgra}=before.pixels,out=after.pixels.bgra
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,j=((flipX?y:h-1-y)*w+(flipX?w-1-x:x))*4;assert.deepEqual(out.subarray(i,i+4),bgra.subarray(j,j+4))}
  }
 }
})
test('opacity multiplies saved alpha; zero alpha remains listed and can be edited again',async()=>{
 let bytes=await fixture({nested:true}),before=await selected(bytes)
 for(const opacity of [.5,.5,0,1]){
  const result=await createIsolatedPdfImageBakesJob().execute(bytes,command({op:'set_image_opacity',page:1,image_number:before.number,opacity})),after=await selected(result.bytes);sameNeighbors(before,after);assert.ok(near(before.item.matrix,after.item.matrix));for(let i=3;i<after.pixels.bgra.length;i+=4)assert.equal(after.pixels.bgra[i],Math.round(before.pixels.bgra[i]*opacity));bytes=result.bytes;before=after
 }
 const result=await createPdfImageBakesJob().execute(bytes,command({op:'flip_image',page:1,image_number:before.number,axis:'horizontal'}));assert.equal((await queryPdfImages(result.bytes)).length,2)
})
test('crop preserves kept intrinsic pixels at their exact original positions through rotated mirrored nested Forms',async()=>{
 for(const pageRotation of [0,90,180,270])for(const turn of [0,90,180,270])for(const mirror of [false,true]){
  const bytes=await fixture({pageRotation,turn,mirror,unit:2,nested:true}),before=await selected(bytes),result=await createPdfImageBakesJob().execute(bytes,command({op:'crop_image',page:1,image_number:before.number,left:.25,bottom:.25})),after=await selected(result.bytes);sameNeighbors(before,after)
  const {width:w,height:h,bgra}=after.pixels;assert.ok(w<4||h<3)
  // Every kept sample must retain both its color and page-space pixel center.
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const p=(y*w+x)*4,color=bgra.subarray(p,p+4),old=before.pixels.bgra;let original=-1;for(let i=0;i<old.length;i+=4)if(old.subarray(i,i+4).equals(color)){original=i/4;break}assert.ok(original>=0)
   const center=(matrix,px,py,pw,ph)=>[matrix[0]*(px+.5)/pw+matrix[2]*(1-(py+.5)/ph)+matrix[4],matrix[1]*(px+.5)/pw+matrix[3]*(1-(py+.5)/ph)+matrix[5]]
   assert.ok(near(center(before.item.matrix,original%4,Math.floor(original/4),4,3),center(after.item.matrix,x,y,w,h)))
  }
 }
})
test('background removal uses the PC edge flood algorithm without removing enclosed same-color islands',async()=>{
 const picture=new PNG({width:7,height:7});for(let y=0;y<7;y++)for(let x=0;x<7;x++){const white=x===0||y===0||x===6||y===6||x===3&&y===3;picture.data.set(white?[255,255,255,255]:[210,10,20,255],(y*7+x)*4)}
 const d=await PDFDocument.create(),p=d.addPage([300,300]),image=await d.embedPng(PNG.sync.write(picture));p.drawImage(image,{x:20,y:40,width:140,height:140});const result=await createPdfImageBakesJob().execute(Buffer.from(await d.save()),command({op:'remove_image_background',page:1,image_number:1,tolerance:0})),pixels=await readImageSource(result.bytes,0,[20,40,160,180]);for(let y=0;y<7;y++)for(let x=0;x<7;x++)assert.equal(pixels.bgra[(y*7+x)*4+3],x===0||y===0||x===6||y===6?0:255)
})
test('bakes validate operations, support affine fallback and cancel isolated work',async()=>{
 for(const op of [{op:'flip_image',axis:'diagonal'},{op:'set_image_opacity',opacity:1.1},{op:'crop_image'},{op:'crop_image',left:.5,right:.5},{op:'remove_image_background',tolerance:101},{op:'flip_image',axis:'horizontal',image:'data'}])assert.throws(()=>validatePdfImageBakeOperation({page:1,image_number:1,...op}))
 const bytes=await fixture({angle:30}),before=await selected(bytes);for(const op of [{op:'flip_image',axis:'horizontal'},{op:'crop_image',left:.2}])assert.ok((await createPdfImageBakesJob().execute(bytes,command({page:1,image_number:before.number,...op}))).bytes.length)
 assert.ok((await createPdfImageBakesJob().execute(bytes,command({op:'set_image_opacity',page:1,image_number:before.number,opacity:.5}))).bytes.length)
 const abort=new AbortController();const pending=createIsolatedPdfImageBakesJob().execute(bytes,command({op:'remove_image_background',page:1,image_number:before.number}),abort.signal);setTimeout(()=>abort.abort(),10);await assert.rejects(pending,{code:'ABORTED'})
})
test('arbitrary rotations use a visual bbox raster and explicit matrix without double rotation',async()=>{
 const {renderImageOccurrence}=await import('../../pdf/src/main/image-edit.ts'),{pdfToView,pdfRectToCss}=await import('../../pdf/src/renderer/annotations.ts')
 async function display(bytes,item,boxOverride){const geom=(await catalog(bytes)).geometries.get(1),box=boxOverride??pdfRectToCss(geom,item.bounds,1),w=Math.ceil(box.width*3),h=Math.ceil(box.height*3),o=pdfToView(geom,0,0),x=pdfToView(geom,1,0),y=pdfToView(geom,0,1),sx=w/box.width,sy=h/box.height,m=[(x[0]-o[0])*sx,(x[1]-o[1])*sy,(y[0]-o[0])*sx,(y[1]-o[1])*sy,(o[0]-box.left)*sx,(o[1]-box.top)*sy];return {pixels:await renderImageOccurrence(bytes,0,item.bounds,w,h,m),w,h,box}}
 for(const pageRotation of [0,90,180,270])for(const nested of [false,true,2])for(const skew of [0,20])for(const opacity of [1,.4]){
  const bytes=await fixture({angle:30,pageRotation,nested,skew,opacity}),before=await selected(bytes),visual=await display(bytes,before.item)
  for(const axis of ['horizontal','vertical']){
   const result=await createPdfImageBakesJob().execute(bytes,command({op:'flip_image',page:1,image_number:before.number,axis})),after=await selected(result.bytes);sameNeighbors(before,after);const rendered=await display(result.bytes,after.item,visual.box);assert.equal(rendered.pixels.length,visual.pixels.length)
   let correct=0,unchanged=0;for(let y=0;y<visual.h;y++)for(let x=0;x<visual.w;x++){const i=(y*visual.w+x)*4,j=((axis==='horizontal'?y:visual.h-1-y)*visual.w+(axis==='horizontal'?visual.w-1-x:x))*4;for(let c=0;c<4;c++){const sample=(data,index)=>c===3?data[index+3]:Math.round(data[index+c]*data[index+3]/255);correct+=Math.abs(sample(rendered.pixels,i)-sample(visual.pixels,j));unchanged+=Math.abs(sample(rendered.pixels,i)-sample(visual.pixels,i))}}
   assert.ok(correct/rendered.pixels.length<2,`mean difference ${correct/rendered.pixels.length}`);assert.ok(correct<unchanged*.4)
  }
  const cropped=await createPdfImageBakesJob().execute(bytes,command({op:'crop_image',page:1,image_number:before.number,left:.2,top:.1})),afterCrop=await selected(cropped.bytes);sameNeighbors(before,afterCrop)
  const kept=await display(cropped.bytes,afterCrop.item),sx=Math.round(visual.w*.2),sy=Math.round(visual.h*.1);let error=0
  for(let y=0;y<kept.h;y++)for(let x=0;x<kept.w;x++){
   const i=(y*kept.w+x)*4,j=((sy+Math.min(visual.h-sy-1,Math.floor(y*(visual.h-sy)/kept.h)))*visual.w+sx+Math.min(visual.w-sx-1,Math.floor(x*(visual.w-sx)/kept.w)))*4
   for(let c=0;c<4;c++){const sample=(data,index)=>c===3?data[index+3]:Math.round(data[index+c]*data[index+3]/255);error+=Math.abs(sample(kept.pixels,i)-sample(visual.pixels,j))}
  }
  assert.ok(error/kept.pixels.length<2,`cropped mean difference ${error/kept.pixels.length}`)
 }
})
test('image bakes preserve AcroForm values, widgets and existing appearances',async()=>{
 const doc=await PDFDocument.load(await fixture()),form=doc.getForm(),page=doc.getPage(0)
 const field=form.createTextField('Review status');field.setText('Approved');field.addToPage(page,{x:24,y:320,width:120,height:24})
 const checkbox=form.createCheckBox('Reviewed');checkbox.addToPage(page,{x:24,y:290,width:16,height:16});checkbox.check()
 const input=Buffer.from(await doc.save()),before=await selected(input)
 const result=await createIsolatedPdfImageBakesJob().execute(input,command({op:'flip_image',page:1,image_number:before.number,axis:'horizontal'}))
 const after=await selected(result.bytes);sameNeighbors(before,after)
 assert.deepEqual(after.pixels.bgra.subarray(0,4),before.pixels.bgra.subarray(12,16))
 assert.equal(pdfInsertFormState(await PDFDocument.load(result.bytes)),pdfInsertFormState(await PDFDocument.load(input)))
})
test('visual crop keeps a slanted image clipped without changing nearby blended artwork',async()=>{
 const picture=new PNG({width:16,height:16})
 for(let i=0;i<picture.data.length;i+=4)picture.data.set([216,24+(i/4)%16,16,255],i)
 for(const nested of [false,true]){
  const doc=await PDFDocument.create(),page=doc.addPage([240,200])
  page.drawRectangle({x:0,y:0,width:240,height:200,color:rgb(.7,.85,1)})
  page.drawRectangle({x:20,y:20,width:12,height:12,color:rgb(.7,.4,.2),blendMode:BlendMode.Multiply})
  page.pushOperators(pushGraphicsState(),rectangle(70,60,82,65),clip(),endPath())
  page.drawImage(await doc.embedPng(PNG.sync.write(picture)),{x:100,y:45,width:100,height:80,rotate:degrees(30)})
  page.pushOperators(popGraphicsState())
  page.drawRectangle({x:113,y:105,width:12,height:12,color:rgb(.1,.6,.2)})
  let bytes=Buffer.from(await doc.save())
  if(nested){
   const outer=await PDFDocument.create(),wrapper=outer.addPage([240,200])
   wrapper.drawPage(await outer.embedPage((await PDFDocument.load(bytes)).getPage(0)))
   bytes=Buffer.from(await outer.save())
  }
  const result=await createPdfImageBakesJob().execute(bytes,command({op:'crop_image',page:1,image_number:1,left:.25}))
  const render=input=>{
   const rendered=spawnSync('pdftoppm',['-png','-singlefile','-r','144','-'],{input,maxBuffer:2*1024*1024,timeout:10000})
   assert.equal(rendered.status,0,String(rendered.stderr||rendered.error))
   const {data,width,height}=PNG.sync.read(rendered.stdout)
   return (x,y)=>data.subarray(((height-1-y*2)*width+x*2)*4,((height-1-y*2)*width+x*2)*4+4)
  }
  const before=render(bytes),after=render(result.bytes),backdrop=before(40,25)
  assert.notDeepEqual(before(80,90),backdrop)
  assert.deepEqual(after(80,90),backdrop,'removed area shows backdrop')
  assert.notDeepEqual(before(120,95),backdrop)
  assert.ok(after(120,95).every((value,i)=>Math.abs(value-before(120,95)[i])<=3),'kept pixels stay in place')
  assert.deepEqual(before(157,95),backdrop)
  assert.deepEqual(after(157,95),backdrop,'original clip still hides pixels to the right')
  assert.notDeepEqual(before(26,26),backdrop)
  assert.deepEqual(after(26,26),before(26,26),'earlier blended artwork is unchanged')
  assert.deepEqual(after(118,111),before(118,111),'later vector drawing is unchanged')
 }
})
test('bakes refuse protected documents, ambiguous image bounds, oversized metadata and unsafe affine clipping',async()=>{
 const bytes=await fixture(),before=await selected(bytes),operation={op:'flip_image',page:1,image_number:before.number,axis:'horizontal'}
 const signed=await PDFDocument.load(bytes);signed.context.register(signed.context.obj({Type:'Sig',ByteRange:[0,1,2,3]}));await assert.rejects(createPdfImageBakesJob().execute(Buffer.from(await signed.save()),command(operation)),{code:'SIGNATURE_EDIT_REFUSED'})
 const forms=await PDFDocument.load(bytes);forms.getForm().createTextField('Form field')
 const withXfa=await PDFDocument.load(await forms.save())
 withXfa.catalog.lookup(PDFName.of('AcroForm')).set(PDFName.of('XFA'),withXfa.context.register(withXfa.context.stream('<xdp/>')))
 await assert.rejects(createPdfImageBakesJob().execute(Buffer.from(await withXfa.save({updateFieldAppearances:false})),command(operation)),{code:'PDF_EDIT_UNSUPPORTED_STRUCTURE'})
 const encrypted=await PDFDocument.load(bytes);encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard',V:1,R:2,Length:40,O:'x',U:'y',P:-4}));await assert.rejects(createPdfImageBakesJob().execute(Buffer.from(await encrypted.save()),command(operation)),{code:'PASSWORD'})
 const duplicate=await PDFDocument.load(bytes);duplicate.getPage(0).drawImage(await duplicate.embedPng(png),{x:250,y:200,width:100,height:75});await assert.rejects(createPdfImageBakesJob().execute(Buffer.from(await duplicate.save()),command(operation)),{code:'PDF_IMAGE_TARGET_AMBIGUOUS'})
 const huge=await PDFDocument.load(bytes);for(const [,object]of huge.context.enumerateIndirectObjects())if(object.dict?.get(PDFName.of('Subtype'))?.toString()==='/Image')object.dict.set(PDFName.of('Width'),huge.context.obj(100000));await assert.rejects(createPdfImageBakesJob().execute(Buffer.from(await huge.save()),command(operation)),error=>['PDF_IMAGE_BAKE_LIMIT','PDF_IMAGE_RESOURCE_UNSUPPORTED'].includes(error.code))
 const clipped=await PDFDocument.create(),small=clipped.addPage([100,100]);small.drawImage(await clipped.embedPng(png),{x:75,y:40,width:100,height:75,rotate:degrees(30)})
 const wrapper=await PDFDocument.create(),wrapperPage=wrapper.addPage([400,400]);wrapperPage.drawPage(await wrapper.embedPage((await PDFDocument.load(await clipped.save())).getPage(0)),{x:50,y:50});await assert.rejects(createPdfImageBakesJob().execute(Buffer.from(await wrapper.save()),command({...operation,image_number:1})),{code:'PDF_IMAGE_BAKE_UNSUPPORTED_TRANSFORM'})
 const grouped=await PDFDocument.load(await fixture({angle:30,nested:true}));for(const [,object]of grouped.context.enumerateIndirectObjects())if(object.dict?.get(PDFName.of('Subtype'))?.toString()==='/Form')object.dict.set(PDFName.of('Group'),grouped.context.obj({S:'Transparency'}))
 const groupBytes=Buffer.from(await grouped.save()),groupNumber=(await selected(groupBytes)).number
 const d=await PDFDocument.create(),page=d.addPage([400,400]),image=await d.embedPng(png)
 page.pushOperators(pushGraphicsState(),rectangle(200,180,80,100),clip(),endPath());page.drawImage(image,{x:250,y:200,width:100,height:75,rotate:degrees(30),opacity:.4,blendMode:BlendMode.Multiply});page.pushOperators(popGraphicsState())
 const blended=await PDFDocument.create(),blendedPage=blended.addPage([500,500]);blendedPage.drawPage(await blended.embedPage((await PDFDocument.load(await fixture({angle:30}))).getPage(0)),{blendMode:BlendMode.Multiply})
 const blendedBytes=Buffer.from(await blended.save()),blendedNumber=(await selected(blendedBytes)).number
 for(const [source,image_number]of [[groupBytes,groupNumber],[Buffer.from(await d.save()),1],[blendedBytes,blendedNumber]])for(const op of [operation,{op:'crop_image',page:1,left:.25}])
  await assert.rejects(createPdfImageBakesJob().execute(source,command({...op,image_number})),{code:'PDF_IMAGE_BAKE_UNSUPPORTED_TRANSFORM'})
 const plainClip=await PDFDocument.create(),plainPage=plainClip.addPage([400,400]);plainPage.pushOperators(pushGraphicsState(),rectangle(200,180,80,100),clip(),endPath());plainPage.drawImage(await plainClip.embedPng(png),{x:250,y:200,width:100,height:75,rotate:degrees(30)});plainPage.pushOperators(popGraphicsState())
 await assert.rejects(createPdfImageBakesJob().execute(Buffer.from(await plainClip.save()),command({...operation,image_number:1})),{code:'PDF_IMAGE_BAKE_UNSUPPORTED_TRANSFORM'})
})
