import {preservePdfManagedStamps} from './stamps-job.mjs'
import {replacePdfImagePixels,createPdfImagePixelSource} from './isolate-image-resources.mjs'
import {PDFDocument,PDFName} from 'pdf-lib'
import {catalog,pdfImageEditsSafetyCodes} from './image-edits-job.mjs'
import {openPdfForPendingEdits} from './pending-document.mjs'
import {assertPdfInsertFormPreserved} from './insert-form-integrity.mjs'
import {pdfToView,pdfRectToCss,viewToPdf} from '../../../../pdf/src/renderer/annotations.ts'
import {flipPixels,multiplyAlpha,DEFAULT_CUTOUT_TOLERANCE} from '../../../../pdf/src/renderer/image-bake.ts'
import {removeBackground} from '../../../../pdf/src/renderer/cutout.ts'
import {concatMat,transformRect} from '../../../../pdf/src/main/form-text.ts'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'
export const pdfImageBakesSafetyCodes=new Set([...pdfImageEditsSafetyCodes,'INVALID_PDF_IMAGE_BAKE','PDF_IMAGE_BAKE_UNSUPPORTED_TRANSFORM','PDF_IMAGE_BAKE_LIMIT','PDF_IMAGE_RESOURCE_UNSUPPORTED'])
export function validatePdfImageBakeOperation(operation){
 if(!operation||typeof operation!=='object'||Array.isArray(operation)||![Object.prototype,null].includes(Object.getPrototypeOf(operation)))fail('INVALID_PDF_IMAGE_BAKE')
 const fields={flip_image:['axis'],set_image_opacity:['opacity'],crop_image:['left','top','right','bottom'],remove_image_background:['tolerance']},kind=Object.getOwnPropertyDescriptor(operation,'op')
 if(!kind||!('value'in kind)||!Object.hasOwn(fields,kind.value))fail('INVALID_PDF_IMAGE_BAKE')
 const allowed=['op','page','image_number',...fields[kind.value]]
 for(const key of Reflect.ownKeys(operation)){const d=Object.getOwnPropertyDescriptor(operation,key);if(!allowed.includes(key)||!d?.enumerable||!('value'in d))fail('INVALID_PDF_IMAGE_BAKE')}
 if(!Number.isSafeInteger(operation.page)||operation.page<1||operation.page>100||!Number.isSafeInteger(operation.image_number)||operation.image_number<1||operation.image_number>1000)fail('INVALID_PDF_IMAGE_BAKE')
 if(operation.op==='flip_image'&&!['horizontal','vertical'].includes(operation.axis))fail('INVALID_PDF_IMAGE_BAKE')
 if(operation.op==='set_image_opacity'&&(typeof operation.opacity!=='number'||!Number.isFinite(operation.opacity)||operation.opacity<0||operation.opacity>1))fail('INVALID_PDF_IMAGE_BAKE')
 if(operation.op==='remove_image_background'&&operation.tolerance!==undefined&&(typeof operation.tolerance!=='number'||!Number.isFinite(operation.tolerance)||operation.tolerance<0||operation.tolerance>100))fail('INVALID_PDF_IMAGE_BAKE')
 if(operation.op==='crop_image'){
  for(const key of ['left','top','right','bottom'])if(key in operation&&(typeof operation[key]!=='number'||!Number.isFinite(operation[key])||operation[key]<0||operation[key]>=1))fail('INVALID_PDF_IMAGE_BAKE')
  if((operation.left??0)+(operation.right??0)>=1||(operation.top??0)+(operation.bottom??0)>=1||!['left','top','right','bottom'].some(key=>operation[key]>0))fail('INVALID_PDF_IMAGE_BAKE')
 }
 return Object.freeze({...operation})
}
export function parsePdfImageBakesRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>65536)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(request,'imageBakes','operation')
 return validatePdfImageBakeOperation(request.operation)
}
const near=(a,b,tolerance=.05)=>a.length===b.length&&a.every((value,index)=>Math.abs(value-b[index])<=tolerance)
const fingerprint=item=>JSON.stringify([item.page,item.type,item.text,item.font,item.image,item.fill,item.stroke,item.size,item.mode])
const same=(a,b)=>fingerprint(a)===fingerprint(b)&&near(a.bounds,b.bounds)&&near(a.matrix,b.matrix)
/** Intrinsic pixels are top-down; PDF image matrices map normalized bottom-up units. */
function displayAxes(matrix,geom){
 const [a,b,c,d,e,f]=matrix,origin=pdfToView(geom,e,f),pointU=pdfToView(geom,e+a,f+b),pointV=pdfToView(geom,e-c,f-d),u=[pointU[0]-origin[0],pointU[1]-origin[1]],v=[pointV[0]-origin[0],pointV[1]-origin[1]],scale=Math.max(...u.map(Math.abs),...v.map(Math.abs))
 const aligned=vector=>Math.min(...vector.map(Math.abs))<=scale*1e-6&&Math.max(...vector.map(Math.abs))>scale*1e-6
 if(!aligned(u)||!aligned(v)||(Math.abs(u[0])>Math.abs(u[1]))===(Math.abs(v[0])>Math.abs(v[1])))fail('PDF_IMAGE_BAKE_UNSUPPORTED_TRANSFORM')
 const horizontal=Math.abs(u[0])>Math.abs(u[1])
 return {x:{axis:horizontal?'u':'v',sign:Math.sign(horizontal?u[0]:v[0])},y:{axis:horizontal?'v':'u',sign:Math.sign(horizontal?v[1]:u[1])}}
}
function rgbaFromBgra(bgra){const data=new Uint8ClampedArray(bgra);for(let i=0;i<data.length;i+=4){data[i]=bgra[i+2];data[i+2]=bgra[i]}return data}
function bgraFromRgba(data){const bgra=Buffer.from(data);for(let i=0;i<bgra.length;i+=4){bgra[i]=data[i+2];bgra[i+2]=data[i]}return bgra}
function bake(source,operation,matrix,axes){
 const input={width:source.width,height:source.height,data:rgbaFromBgra(source.bgra)}
 let data,width=source.width,height=source.height,expectedMatrix=matrix
 if(operation.op==='flip_image')data=flipPixels(input,axes[operation.axis==='horizontal'?'x':'y'].axis==='u'?'h':'v')
 else if(operation.op==='set_image_opacity')data=multiplyAlpha(input,operation.opacity)
 else if(operation.op==='remove_image_background')data=removeBackground(input,operation.tolerance??DEFAULT_CUTOUT_TOLERANCE).data
 else{
  const ranges={}
  for(const [display,low,high]of [['x',operation.left??0,operation.right??0],['y',operation.top??0,operation.bottom??0]]){const mapped=axes[display];ranges[mapped.axis]=mapped.sign>0?[low,1-high]:[high,1-low]}
  const sx=Math.round(ranges.u[0]*width),ex=Math.round(ranges.u[1]*width),sy=Math.round(ranges.v[0]*height),ey=Math.round(ranges.v[1]*height)
  if(ex<=sx||ey<=sy||(sx===0&&sy===0&&ex===width&&ey===height))fail('INVALID_PDF_IMAGE_BAKE')
  const u0=sx/width,v0=1-ey/height,du=(ex-sx)/width,dv=(ey-sy)/height,[a,b,c,d,e,f]=matrix
  expectedMatrix=[a*du,b*du,c*dv,d*dv,e+a*u0+c*v0,f+b*u0+d*v0]
  width=ex-sx;height=ey-sy;data=new Uint8ClampedArray(width*height*4)
  for(let y=0;y<height;y++)data.set(input.data.subarray(((sy+y)*input.width+sx)*4,((sy+y)*input.width+ex)*4),y*width*4)
 }
 return {width,height,bgra:bgraFromRgba(data),matrix:expectedMatrix,rect:transformRect([0,0,1,1],expectedMatrix)}
}
/** Rasterize a bare intrinsic image through the effective affine transform.
 * No original alpha/blend/clip state is baked twice; the writer preserves it. */
async function rasterFallback(bare,matrix,geom,operation){
 const {renderImageOccurrence}=await import('../../../../pdf/src/main/image-edit.ts'),box=pdfRectToCss(geom,transformRect([0,0,1,1],matrix),1)
 const width=Math.ceil(box.width*3),height=Math.ceil(box.height*3)
 if(width<1||height<1||width>8192||height>8192||width*height*4>32*1024*1024)fail('PDF_IMAGE_BAKE_LIMIT')
 const origin=pdfToView(geom,0,0),x=pdfToView(geom,1,0),y=pdfToView(geom,0,1),toDisplay=[x[0]-origin[0],x[1]-origin[1],y[0]-origin[0],y[1]-origin[1],...origin]
 const tempMatrix=concatMat(concatMat(matrix,toDisplay),[1,0,0,-1,-box.left,box.top+box.height])
 const doc=await PDFDocument.load(bare.bytes,{updateMetadata:false}),page=doc.getPage(0);page.setSize(box.width,box.height);page.setCropBox(0,0,box.width,box.height)
 page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(`q\n${tempMatrix.join(' ')} cm\n/IntrinsicImage Do\nQ\n`)))
 const bytes=Buffer.from(await doc.save()),bgra=await renderImageOccurrence(bytes,0,[0,0,box.width,box.height],width,height,[width/box.width,0,0,-height/box.height,0,height])
 let pixels={width,height,bgra},rect=transformRect([0,0,1,1],matrix)
 if(operation.op==='flip_image')pixels.bgra=bgraFromRgba(flipPixels({width,height,data:rgbaFromBgra(bgra)},operation.axis==='horizontal'?'h':'v'))
 else{
  const sx=Math.round((operation.left??0)*width),ex=Math.round((1-(operation.right??0))*width),sy=Math.round((operation.top??0)*height),ey=Math.round((1-(operation.bottom??0))*height)
  if(ex<=sx||ey<=sy||(sx===0&&sy===0&&ex===width&&ey===height))fail('INVALID_PDF_IMAGE_BAKE')
  const cropped=Buffer.alloc((ex-sx)*(ey-sy)*4)
  for(let row=sy;row<ey;row++)cropped.set(bgra.subarray((row*width+sx)*4,(row*width+ex)*4),(row-sy)*(ex-sx)*4)
  pixels={width:ex-sx,height:ey-sy,bgra:cropped}
  const a=viewToPdf(geom,box.left+sx/width*box.width,box.top+sy/height*box.height),b=viewToPdf(geom,box.left+ex/width*box.width,box.top+ey/height*box.height)
  rect=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]
 }
 const {imageMatrix}=await import('../../../../pdf/src/main/image-edit.ts')
 return {...pixels,rect,matrix:imageMatrix(rect,geom.rot)}
}
export function createPdfImageBakesJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||input.length<1||input.length>64*1024*1024)fail('INPUT_LIMIT')
  const operation=parsePdfImageBakesRequest(raw),original=Buffer.from(input);busy=true
  try{
   const sourceDoc=await openPdfForPendingEdits(original),{entries,geometries}=await catalog(original,signal),entry=entries.find(entry=>entry.image.page===operation.page&&entry.image.image_number===operation.image_number);if(!entry)fail('PDF_IMAGE_NOT_FOUND')
   const {readImageSource,readImageBitmap}=await import('../../../../pdf/src/main/image-edit.ts'),{readPdfLeafObjects}=await import('../../../../pdf/src/main/text-edit.ts')
   const before=await readPdfLeafObjects(original,true),matches=before.map((item,index)=>({item,index})).filter(({item})=>item.page===operation.page-1&&item.type===3&&near(item.bounds,entry.ref.rect,2));if(matches.length!==1)fail('PDF_IMAGE_TARGET_AMBIGUOUS')
   const ordinal=before.slice(0,matches[0].index).filter(item=>item.page===operation.page-1&&item.type===3).length,bare=await createPdfImagePixelSource(original,operation.page-1,ordinal)
   let source;try{source=await readImageSource(bare.bytes,0,[0,0,bare.width,bare.height])}catch(error){if(error.message?.includes('limit'))fail('PDF_IMAGE_BAKE_LIMIT');throw error}
   const target=matches[0];if(Math.abs(target.item.matrix[0]*target.item.matrix[3]-target.item.matrix[1]*target.item.matrix[2])<1e-8)fail('PDF_IMAGE_BAKE_UNSUPPORTED_TRANSFORM')
   let axes,expected
   if(['flip_image','crop_image'].includes(operation.op)){
    try{axes=displayAxes(target.item.matrix,geometries.get(operation.page))}catch(error){
     // Crop keeps the surviving pixels at their original page coordinates.
     // The writer retains the occurrence's blend, group and clipping state.
     // A flip would move pixels across the stationary occurrence clip.
     if(operation.op==='flip_image'){
      if(!bare.rasterSafe)throw error
      const {imageOccurrenceHasClip}=await import('../../../../pdf/src/main/image-edit.ts')
      if(await imageOccurrenceHasClip(original,operation.page-1,entry.ref.rect))throw error
     }
     expected=await rasterFallback(bare,target.item.matrix,geometries.get(operation.page),operation)
    }
   }
   expected??=bake(source,operation,target.item.matrix,axes);check(signal)
   const [a,b,c,d,e,f]=target.item.matrix,det=a*d-b*c,inverse=[d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det],normalized=concatMat(expected.matrix,inverse)
   const bytes=await replacePdfImagePixels(original,operation.page-1,ordinal,expected,near(expected.matrix,target.item.matrix)?undefined:normalized);check(signal)
   if(bytes.length<1||bytes.length>64*1024*1024)fail('OUTPUT_LIMIT')
   const after=await readPdfLeafObjects(bytes,true);if(after.length!==before.length)fail('PDF_IMAGE_VERIFY_FAILED')
   for(let index=0;index<after.length;index++){const item=after[index];if(index!==target.index){if(!same(before[index],item))fail('PDF_IMAGE_VERIFY_FAILED')}else if(item.type!==3||item.page!==target.item.page||!near(item.bounds,expected.rect)||!near(item.matrix,expected.matrix))fail('PDF_IMAGE_VERIFY_FAILED')}
   const savedBare=await createPdfImagePixelSource(bytes,operation.page-1,ordinal),actual=await readImageBitmap(savedBare.bytes,0,[0,0,savedBare.width,savedBare.height],expected.width,expected.height)
   for(let i=0;i<actual.length;i+=4){if(actual[i+3]!==expected.bgra[i+3])fail('PDF_IMAGE_VERIFY_FAILED');if(actual[i+3]&&[0,1,2].some(offset=>actual[i+offset]!==expected.bgra[i+offset]))fail('PDF_IMAGE_VERIFY_FAILED')}
   const preserved=await preservePdfManagedStamps(original,bytes,{allowAcroForm:true})
   const savedDoc=await openPdfForPendingEdits(preserved)
   if(savedDoc.getPageCount()!==sourceDoc.getPageCount())fail('PDF_IMAGE_VERIFY_FAILED')
   assertPdfInsertFormPreserved(sourceDoc,savedDoc);check(signal)
   return {bytes:preserved,inputSha256:hash(original),sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(error?.message?.includes('limit'))fail('PDF_IMAGE_BAKE_LIMIT');if(pdfImageBakesSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
