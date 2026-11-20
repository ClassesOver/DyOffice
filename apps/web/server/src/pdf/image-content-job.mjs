import {preservePdfManagedStamps} from './stamps-job.mjs'
import {replacePdfImagePixels,createPdfImagePixelSource} from './isolate-image-resources.mjs'
import {createHash} from 'node:crypto'
import {PNG} from 'pngjs'
import {JpegImage} from 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs'
import {catalog,pdfImageEditsSafetyCodes} from './image-edits-job.mjs'
import {anchorRect,pdfTextInsertsSafetyCodes} from './text-inserts-job.mjs'
import {openPdfForPendingEdits} from './pending-document.mjs'
import {assertPdfInsertFormPreserved} from './insert-form-integrity.mjs'
import {PDF_OPEN_OPTIONS} from '../../../src/editors/pdf-csp.ts'
import {pdfRectToCss,viewToPdf,geomDispSize} from '../../../../pdf/src/renderer/annotations.ts'
const MAX_IMAGE_BYTES=5*1024*1024,MAX_RGBA_BYTES=32*1024*1024,MAX_REQUEST_BYTES=7*1024*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
export const pdfImageContentSafetyCodes=new Set([...pdfImageEditsSafetyCodes,...pdfTextInsertsSafetyCodes,'INVALID_PDF_IMAGE_CONTENT','PDF_IMAGE_FORMAT_UNSUPPORTED','PDF_IMAGE_CONTENT_LIMIT','PDF_IMAGE_CONTENT_DECODE_FAILED','PDF_IMAGE_RESOURCE_UNSUPPORTED'])
function plain(value){return value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key)?.enumerable&&'value'in Object.getOwnPropertyDescriptor(value,key))}
export function validatePdfImageContentOperation(operation){
 if(!plain(operation)||!['insert_image','replace_image'].includes(operation.op))fail('INVALID_PDF_IMAGE_CONTENT')
 const allowed=operation.op==='insert_image'?['op','page','image','anchor_text','placement','x','y','width','layer']:['op','page','image_number','image']
 if(Object.keys(operation).some(key=>!allowed.includes(key))||!Number.isSafeInteger(operation.page)||operation.page<1||operation.page>100)fail('INVALID_PDF_IMAGE_CONTENT')
 if(operation.op==='replace_image'&&(!Number.isSafeInteger(operation.image_number)||operation.image_number<1||operation.image_number>1000))fail('INVALID_PDF_IMAGE_CONTENT')
 const image=operation.image
 if(!plain(image)||Object.keys(image).sort().join(',')!=='base64,mime'||typeof image.base64!=='string'||!image.base64.length||image.base64.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!['image/png','image/jpeg'].includes(image.mime))fail('INVALID_PDF_IMAGE_CONTENT')
 if(('anchor_text'in operation&&(typeof operation.anchor_text!=='string'||operation.anchor_text.length>2000))||('placement'in operation&&!['above','below','left','right'].includes(operation.placement))||('layer'in operation&&!['above_text','below_text'].includes(operation.layer)))fail('INVALID_PDF_IMAGE_CONTENT')
 for(const key of ['x','y','width'])if(key in operation&&(typeof operation[key]!=='number'||!Number.isFinite(operation[key])||Math.abs(operation[key])>100000||(key==='width'&&operation[key]<=0)))fail('INVALID_PDF_IMAGE_CONTENT')
 return Object.freeze({...operation,image:Object.freeze({...image}),...('anchor_text'in operation?{anchor_text:operation.anchor_text.trim()}:{})})
}
export function parsePdfImageContentRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>MAX_REQUEST_BYTES)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!request||Object.keys(request).sort().join(',')!=='action,operation,version'||request.version!==1||request.action!=='imageContent')fail('INVALID_REQUEST')
 return validatePdfImageContentOperation(request.operation)
}
function dimensions(bytes,mime){
 if(mime==='image/png'){
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
  let offset=8,headers=0,ended=false
  while(offset+12<=bytes.length){
   const length=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8)
   if(length>bytes.length-offset-12)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
   if(kind==='IHDR'&&++headers!==1)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
   offset+=length+12
   if(kind==='IEND'){ended=true;break}
  }
  if(!ended||offset!==bytes.length)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
  return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)]
 }
 if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
 let offset=2
 while(offset+4<=bytes.length){
  if(bytes[offset++]!==255)break
  while(bytes[offset]===255)offset++
  const marker=bytes[offset++]
  if(marker===217||marker===218)break
  if(marker===1||(marker>=208&&marker<=215))continue
  if(offset+2>bytes.length)break
  const length=bytes.readUInt16BE(offset)
  if(length<2||offset+length>bytes.length)break
  if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)break;const count=bytes[offset+7];if(count<1||count>4||length!==8+count*3)break
   for(let i=0;i<count;i++){const sample=bytes[offset+9+i*3];if((sample>>4)<1||(sample>>4)>4||(sample&15)<1||(sample&15)>4)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')}
   return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)]}
  offset+=length
 }
 fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
}
/** Strict byte/size gate before either decoder allocates the pixel plane. */
export function decodePdfImage(image){
 if(!image||!['image/png','image/jpeg'].includes(image.mime))fail('PDF_IMAGE_FORMAT_UNSUPPORTED')
 if(typeof image.base64!=='string'||!image.base64.length||image.base64.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||image.base64.length%4!==0)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
 const bytes=Buffer.from(image.base64,'base64');if(bytes.length>MAX_IMAGE_BYTES)fail('PDF_IMAGE_CONTENT_LIMIT');if(bytes.toString('base64')!==image.base64)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
 const [width,height]=dimensions(bytes,image.mime)
 if(width<1||height<1||width>8192||height>8192||width*height*4>MAX_RGBA_BYTES)fail('PDF_IMAGE_CONTENT_LIMIT')
 let rgba,decodedWidth,decodedHeight
 try{
  if(image.mime==='image/png'){const decoded=PNG.sync.read(bytes,{checkCRC:true});rgba=decoded.data;decodedWidth=decoded.width;decodedHeight=decoded.height}
  else{const decoder=new JpegImage();decoder.parse(bytes,{dnlScanLines:height});decodedWidth=decoder.width;decodedHeight=decoder.height;rgba=decoder.getData({width,height,forceRGBA:true})}
 }catch{fail('PDF_IMAGE_CONTENT_DECODE_FAILED')}
 if(decodedWidth!==width||decodedHeight!==height||rgba?.length!==width*height*4)fail('PDF_IMAGE_CONTENT_DECODE_FAILED')
 const bgra=Buffer.from(rgba);for(let i=0;i<bgra.length;i+=4){bgra[i]=rgba[i+2];bgra[i+2]=rgba[i]}
 return {width,height,bgra}
}
const near=(a,b,tolerance=.05)=>a.length===b.length&&a.every((value,index)=>Math.abs(value-b[index])<=tolerance)
const fingerprint=item=>JSON.stringify([item.page,item.type,item.text,item.font,item.image,item.fill,item.stroke,item.size,item.mode])
const same=(a,b)=>fingerprint(a)===fingerprint(b)&&near(a.bounds,b.bounds)&&near(a.matrix,b.matrix)
export async function planPdfImageContent(bytes,operation,decoded,signal,independentHeight,rotationDelta=0){
 const {entries,geometries}=await catalog(bytes,signal),base=geometries.get(operation.page);if(!base)fail('INVALID_PDF_IMAGE_CONTENT')
 const geom={...base,rot:(base.rot+rotationDelta)%360}
 const {readPdfLeafObjects}=await import('../../../../pdf/src/main/text-edit.ts'),objects=await readPdfLeafObjects(bytes,true)
 if(operation.op==='replace_image'){
  const target=entries.find(entry=>entry.image.page===operation.page&&entry.image.image_number===operation.image_number);if(!target)fail('PDF_IMAGE_NOT_FOUND')
  const found=objects.map((item,index)=>({item,index})).filter(({item})=>item.type===3&&item.page===operation.page-1&&near(item.bounds,target.ref.rect,2));if(found.length!==1)fail('PDF_IMAGE_TARGET_AMBIGUOUS')
  return {objects,index:found[0].index,edit:{kind:'replaceImage',pageIndex:operation.page-1,oldRect:target.ref.rect,rect:target.ref.rect,image:operation.image.base64}}
 }
 const size=geomDispSize(geom);let width=operation.width??(independentHeight!==undefined?independentHeight*decoded.width/decoded.height:Math.min(decoded.width*72/96,size.width/2)),height=independentHeight??width*decoded.height/decoded.width
 const fit=Math.min(1,size.width/width,size.height/height);width*=fit;height*=fit
 let x,y
 if(operation.anchor_text){
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument({data:Uint8Array.from(bytes),...PDF_OPEN_OPTIONS,disableFontFace:true,useSystemFonts:true})
  try{
   const page=await (await task.promise).getPage(operation.page),anchor=pdfRectToCss(geom,anchorRect(await page.getTextContent(),operation.anchor_text),1)
   switch(operation.placement??'below'){
    case 'above':x=anchor.left;y=anchor.top-8-height;break
    case 'left':x=anchor.left-8-width;y=anchor.top+anchor.height/2-height/2;break
    case 'right':x=anchor.left+anchor.width+8;y=anchor.top+anchor.height/2-height/2;break
    default:x=anchor.left;y=anchor.top+anchor.height+8
   }
  }finally{await task.destroy()}
 }else if(operation.x!==undefined||operation.y!==undefined){x=operation.x??0;y=operation.y??0}
 else{x=(size.width-width)/2;y=(size.height-height)/2}
 x=Math.min(Math.max(x,0),size.width-width);y=Math.min(Math.max(y,0),size.height-height)
 const a=viewToPdf(geom,x,y),b=viewToPdf(geom,x+width,y+height),rect=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]
 if(entries.some(entry=>entry.image.page===operation.page&&near(entry.ref.rect,rect,2)))fail('PDF_IMAGE_TARGET_AMBIGUOUS')
 if(entries.length>=1000)fail('PDF_EDIT_LIMIT')
 return {objects,index:-1,preview:{page:operation.page,x,y,width,height,layer:operation.layer??'below_text',pixelWidth:decoded.width,pixelHeight:decoded.height},edit:{kind:'insertImage',pageIndex:operation.page-1,rect,rotate:geom.rot,layer:operation.layer==='above_text'?'aboveText':'belowText',image:operation.image.base64}}
}
export function createPdfImageContentJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||input.length<1||input.length>64*1024*1024)fail('INPUT_LIMIT')
  const operation=parsePdfImageContentRequest(raw),original=Buffer.from(input);busy=true
  try{
   const source=await openPdfForPendingEdits(original),decoded=decodePdfImage(operation.image),planned=await planPdfImageContent(original,operation,decoded,signal),{applyImageEdits,readImageBitmap,imageMatrix}=await import('../../../../pdf/src/main/image-edit.ts'),{readPdfLeafObjects}=await import('../../../../pdf/src/main/text-edit.ts');check(signal)
   let output
   if(planned.index>=0){const ordinal=planned.objects.slice(0,planned.index).filter(item=>item.page===operation.page-1&&item.type===3).length;output=await replacePdfImagePixels(original,operation.page-1,ordinal,decoded)}
   else{const applied=await applyImageEdits(original,[planned.edit],()=>decoded);if(applied.skipped.length)fail('PDF_IMAGE_EDIT_REFUSED');output=applied.bytes}
   check(signal)
   const bytes=Buffer.from(output);if(bytes.length<1||bytes.length>64*1024*1024)fail('OUTPUT_LIMIT')
   const after=await readPdfLeafObjects(bytes,true),expectedCount=planned.objects.length+(planned.index<0?1:0)
   if(after.length!==expectedCount)fail('PDF_IMAGE_VERIFY_FAILED')
   const targets=after.map((item,index)=>({item,index})).filter(({item})=>item.type===3&&item.page===operation.page-1&&near(item.bounds,planned.edit.rect)),target=targets[0]
   if(targets.length!==1)fail('PDF_IMAGE_VERIFY_FAILED')
   const matrix=planned.index<0?imageMatrix(planned.edit.rect,planned.edit.rotate):planned.objects[planned.index].matrix
   if(!near(target.item.matrix,matrix))fail('PDF_IMAGE_VERIFY_FAILED')
   const beforeOther=planned.objects.filter((_,index)=>index!==planned.index),afterOther=after.filter((_,index)=>index!==target.index)
   if(beforeOther.length!==afterOther.length||beforeOther.some((item,index)=>!same(item,afterOther[index])))fail('PDF_IMAGE_VERIFY_FAILED')
   if(planned.index>=0&&target.index!==planned.index)fail('PDF_IMAGE_VERIFY_FAILED')
   if(planned.index<0){const text=after.findIndex(item=>item.page===operation.page-1&&item.type===1);if(text>=0&&((planned.edit.layer==='aboveText'&&target.index<text)||(planned.edit.layer==='belowText'&&target.index>text)))fail('PDF_IMAGE_VERIFY_FAILED')}
   const ordinal=after.slice(0,target.index).filter(item=>item.page===operation.page-1&&item.type===3).length,bare=await createPdfImagePixelSource(bytes,operation.page-1,ordinal)
   const actual=await readImageBitmap(bare.bytes,0,[0,0,bare.width,bare.height],decoded.width,decoded.height)
   for(let i=0;i<actual.length;i+=4){if(actual[i+3]!==decoded.bgra[i+3])fail('PDF_IMAGE_VERIFY_FAILED');if(actual[i+3]&&[0,1,2].some(offset=>actual[i+offset]!==decoded.bgra[i+offset]))fail('PDF_IMAGE_VERIFY_FAILED')}
   const preserved=await preservePdfManagedStamps(original,bytes,{allowAcroForm:true})
   const saved=await openPdfForPendingEdits(preserved)
   if(saved.getPageCount()!==source.getPageCount())fail('PDF_IMAGE_VERIFY_FAILED')
   assertPdfInsertFormPreserved(source,saved);check(signal)
   return {bytes:preserved,inputSha256:hash(original),sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(pdfImageContentSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
