import {PNG} from 'pngjs'
import {catalog,createPdfImageEditsJob,validatePdfImageEditOperations} from './image-edits-job.mjs'
import {createPdfImageBakesJob,validatePdfImageBakeOperation,pdfImageBakesSafetyCodes} from './image-bakes-job.mjs'
import {geomDispSize} from '../../../../pdf/src/renderer/annotations.ts'
import {createHash} from 'node:crypto'
import {openPdfForPendingEdits} from './pending-document.mjs'
import {openPdfForInserts,assertPdfInsertFormPreserved} from './insert-form-integrity.mjs'
import {decodePdfImage,planPdfImageContent,validatePdfImageContentOperation,pdfImageContentSafetyCodes,createPdfImageContentJob} from './image-content-job.mjs'
import {createPdfTextInsertsJob,validatePdfTextInsertOperations} from './text-inserts-job.mjs'
import {preservePdfManagedStamps} from './stamps-job.mjs'
import {createPdfImagePixelSource} from './isolate-image-resources.mjs'
const MAX=64*1024*1024,RAW=32*1024*1024,hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(Error(code),{code})}
const check=signal=>{if(signal?.aborted)fail('ABORTED')}
export const pdfDraftInsertsSafetyCodes=new Set([...pdfImageContentSafetyCodes,...pdfImageBakesSafetyCodes,'INVALID_PDF_DRAFT_INSERTS','PDF_DRAFT_INSERT_VERIFY_FAILED','PDF_STAMP_INTEGRITY_FAILED','PDF_IMAGE_BAKE_LIMIT'])
export function validatePdfPendingImageInsert(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_PDF_IMAGE_CONTENT')
 const {height,...rest}=input
 if('height'in input&&(typeof height!=='number'||!Number.isFinite(height)||height<=0||height>100000))fail('INVALID_PDF_IMAGE_CONTENT')
 const validated=validatePdfImageContentOperation({...rest,op:'insert_image'})
 if('op'in input)fail('INVALID_PDF_IMAGE_CONTENT')
 const {op,...value}=validated;return {...value,...('height'in input?{height}:{})}
}
export function validatePdfDraftInserts(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(key=>!['images','texts','imageEdits'].includes(key)||!Object.getOwnPropertyDescriptor(input,key)?.enumerable||!('value'in Object.getOwnPropertyDescriptor(input,key)))||!Array.isArray(input.texts)||!Array.isArray(input.images)||input.texts.length>20||input.images.length>20||('imageEdits'in input&&(!Array.isArray(input.imageEdits)||input.imageEdits.length>20||Reflect.ownKeys(input.imageEdits).length!==input.imageEdits.length+1)))fail('INVALID_PDF_DRAFT_INSERTS')
 const texts=input.texts.length?validatePdfTextInsertOperations(input.texts):[],images=input.images.map(validatePdfPendingImageInsert),claimed=new Set()
 const imageEdits=(input.imageEdits??[]).map(item=>{
  const kind=item&&typeof item==='object'?Object.getOwnPropertyDescriptor(item,'op'):undefined
  if(!kind||!('value'in kind))fail('INVALID_PDF_DRAFT_INSERTS')
  const operation=kind.value==='replace_image'?validatePdfImageContentOperation(item):['transform_image','rotate_image','delete_image'].includes(kind.value)?validatePdfImageEditOperations([item])[0]:validatePdfImageBakeOperation(item)
  const key=`${operation.page}:${operation.image_number}`;if(claimed.has(key))fail('INVALID_PDF_DRAFT_INSERTS');claimed.add(key);return operation
 })
 if(!texts.length&&!images.length&&!imageEdits.length)fail('INVALID_PDF_DRAFT_INSERTS')
 if([...images,...imageEdits.filter(item=>item.op==='replace_image')].reduce((total,item)=>total+Buffer.byteLength(item.image.base64,'base64'),0)>20*1024*1024)fail('PDF_IMAGE_CONTENT_LIMIT')
 return {texts,images,...('imageEdits'in input?{imageEdits}:{})}
}
export function parsePdfDraftInsertsRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>RAW)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(request?.version!==1||!['imageInsertsQuery','draftInserts','draftInsertsQuery'].includes(request.action))fail('INVALID_REQUEST')
 const keys=Object.keys(request).sort().join(',')
 if(request.action==='imageInsertsQuery'){
  if(!['action,operation,version','action,operation,rotationDelta,version'].includes(keys))fail('INVALID_REQUEST')
  const rotationDelta='rotationDelta'in request?request.rotationDelta:0
  if(![0,90,180,270].includes(rotationDelta))fail('INVALID_PDF_IMAGE_CONTENT')
  return {operation:validatePdfPendingImageInsert(request.operation),rotationDelta}
 }
 if(keys!=='action,operation,version')fail('INVALID_REQUEST')
 return validatePdfDraftInserts(request.operation)
}
const near=(a,b)=>a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<.1)
const same=(a,b)=>JSON.stringify([a.page,a.type,a.text,a.font,a.image,a.fill,a.stroke,a.size,a.mode])===JSON.stringify([b.page,b.type,b.text,b.font,b.image,b.fill,b.stroke,b.size,b.mode])&&near(a.bounds,b.bounds)&&near(a.matrix,b.matrix)
async function planImage(original,operation,signal,rotationDelta=0){
 const decoded=decodePdfImage(operation.image),{height,...rest}=operation,plan=await planPdfImageContent(original,{...rest,op:'insert_image'},decoded,signal,height,rotationDelta)
 return {...plan,operation}
}
export async function applyExistingImages(original,operations,signal,directTargets=[]){
 if(!operations.length)return original
 const source=await catalog(original,signal),targets=operations.map(operation=>{
  const entry=source.entries.find(entry=>entry.image.page===operation.page&&entry.image.image_number===operation.image_number)
  if(!entry)fail('PDF_IMAGE_NOT_FOUND')
  if(source.entries.filter(other=>other.image.page===operation.page&&near(other.ref.rect,entry.ref.rect)).length!==1)fail('PDF_IMAGE_TARGET_AMBIGUOUS')
  if(directTargets.some(target=>target.pageIndex===operation.page-1&&target.oldRect.every((value,index)=>Math.abs(value-entry.ref.rect[index])<=2)))fail('PDF_IMAGE_TARGET_AMBIGUOUS')
  return {operation,rect:entry.ref.rect}
 })
 let working=original
 for(const {operation,rect}of targets){
  check(signal)
  // Catalog numbers are display-sort positions. Earlier deletes/moves can change them;
  // rematch the still untouched original rectangle, refusing collisions rather than guessing.
  const current=await catalog(working,signal),matches=current.entries.filter(entry=>entry.image.page===operation.page&&near(entry.ref.rect,rect))
  if(matches.length!==1)fail('PDF_IMAGE_TARGET_AMBIGUOUS')
  const updated={...operation,image_number:matches[0].image.image_number}
  const geometry=['transform_image','rotate_image','delete_image'].includes(operation.op),replacement=operation.op==='replace_image',action=geometry?'imageEdits':replacement?'imageContent':'imageBakes',job=geometry?createPdfImageEditsJob():replacement?createPdfImageContentJob():createPdfImageBakesJob()
  working=(await job.execute(working,JSON.stringify({version:1,action,...(geometry?{operations:[updated]}:{operation:updated})}),signal)).bytes
 }
 return working
}
async function renderDraftPages(bytes,operation,signal){
 const {geometries}=await catalog(bytes,signal),pageNumbers=[...new Set([...operation.texts,...operation.images,...operation.imageEdits??[]].map(item=>item.page))].sort((a,b)=>a-b),{chainPdfium,loadPdfium,withDocument}=await import('../../../../pdf/src/main/text-edit.ts')
 let totalPixels=0,totalPng=0
 return chainPdfium(async()=>{const m=await loadPdfium();return withDocument(m,bytes,async doc=>{
  const pages=[]
  for(const number of pageNumbers){
   check(signal);const geom=geometries.get(number);if(!geom)fail('INVALID_PDF_DRAFT_INSERTS');const size=geomDispSize(geom),w=Math.ceil(size.width),h=Math.ceil(size.height),pixels=w*h
   if(!Number.isFinite(pixels)||w<1||h<1||pixels>16000000||(totalPixels+=pixels)>64000000)fail('PDF_IMAGE_BAKE_LIMIT')
   const page=m._FPDF_LoadPage(doc,number-1);if(!page)fail('UNREADABLE');const ptr=m._malloc(pixels*4),bitmap=m._FPDFBitmap_CreateEx(w,h,4,ptr,w*4)
   try{
    if(!bitmap)fail('NATIVE_FAILED');m._FPDFBitmap_FillRect(bitmap,0,0,w,h,0xffffffff);m._FPDF_RenderPageBitmap(bitmap,page,0,0,w,h,0,1)
    const rgba=Buffer.from(m.HEAPU8.subarray(ptr,ptr+pixels*4));for(let i=0;i<rgba.length;i+=4){const blue=rgba[i];rgba[i]=rgba[i+2];rgba[i+2]=blue}
    const png=PNG.sync.write({width:w,height:h,data:rgba});if((totalPng+=png.length)>24*1024*1024)fail('OUTPUT_LIMIT')
    pages.push({page:number,width:size.width,height:size.height,png:png.toString('base64')})
   }finally{if(bitmap)m._FPDFBitmap_Destroy(bitmap);m._free(ptr);m._FPDF_ClosePage(page)}
  }
  return pages
 })})
}
export function createPdfDraftInsertsJob(action){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX)fail('INPUT_LIMIT')
  const operation=parsePdfDraftInsertsRequest(raw),original=Buffer.from(input);busy=true
  try{
   if(action==='imageInsertsQuery'){
    await openPdfForInserts(original,{planning:true})
    const plan=await planImage(original,operation.operation,signal,operation.rotationDelta);check(signal);const bytes=Buffer.from(JSON.stringify({image:plan.preview,edit:plan.edit}));return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
   }
   const openSource=operation.imageEdits?.length?openPdfForPendingEdits:openPdfForInserts,source=await openSource(original)
   let working=await applyExistingImages(original,operation.imageEdits??[],signal)
   const plans=[];for(const image of operation.images){plans.push(await planImage(working,image,signal));check(signal)}
   if(operation.texts.length)working=(await createPdfTextInsertsJob().execute(working,JSON.stringify({version:1,action:'textInserts',operations:operation.texts}),signal)).bytes
   const {readPdfLeafObjects}=await import('../../../../pdf/src/main/text-edit.ts'),{applyImageEdits,imageMatrix,readImageBitmap}=await import('../../../../pdf/src/main/image-edit.ts'),before=await readPdfLeafObjects(working,true)
   if(plans.length){
    const sources=new Map(plans.map(plan=>[plan.operation.image.base64,plan.operation.image]))
    const applied=await applyImageEdits(working,plans.map(plan=>plan.edit),base64=>{const image=sources.get(base64);if(!image)fail('INVALID_PDF_IMAGE_CONTENT');return decodePdfImage(image)});check(signal)
    if(applied.skipped.length)fail('PDF_IMAGE_EDIT_REFUSED');working=Buffer.from(applied.bytes)
   }
   const after=await readPdfLeafObjects(working,true),inserted=new Set()
   if(after.length!==before.length+plans.length)fail('PDF_DRAFT_INSERT_VERIFY_FAILED')
   for(const plan of plans){
    const expected=imageMatrix(plan.edit.rect,plan.edit.rotate),found=after.map((item,index)=>({item,index})).filter(({item,index})=>!inserted.has(index)&&item.type===3&&item.page===plan.edit.pageIndex&&near(item.matrix,expected));let selected
    const decoded=decodePdfImage(plan.operation.image)
    for(const candidate of found){
     const ordinal=after.slice(0,candidate.index).filter(item=>item.type===3&&item.page===candidate.item.page).length,bare=await createPdfImagePixelSource(working,candidate.item.page,ordinal),actual=await readImageBitmap(bare.bytes,0,[0,0,bare.width,bare.height],decoded.width,decoded.height)
     if(actual.length!==decoded.bgra.length)continue
     let matches=true;for(let i=0;i<actual.length;i+=4){if(actual[i+3]!==decoded.bgra[i+3]||actual[i+3]&&[0,1,2].some(offset=>actual[i+offset]!==decoded.bgra[i+offset])){matches=false;break}}
     if(matches){selected=candidate;break}
    }
    if(!selected)fail('PDF_DRAFT_INSERT_VERIFY_FAILED');inserted.add(selected.index)
    const pageTexts=after.map((item,index)=>({item,index})).filter(({item})=>item.page===plan.edit.pageIndex&&item.type===1)
    if(pageTexts.length&&(plan.edit.layer==='aboveText'?selected.index<Math.max(...pageTexts.map(item=>item.index)):selected.index>Math.min(...pageTexts.map(item=>item.index))))fail('PDF_DRAFT_INSERT_VERIFY_FAILED')
   }
   const others=after.filter((_,index)=>!inserted.has(index));if(others.length!==before.length||before.some((item,index)=>!same(item,others[index])))fail('PDF_DRAFT_INSERT_VERIFY_FAILED')
   const bytes=await preservePdfManagedStamps(original,working,{allowAcroForm:true});check(signal)
   if(bytes.length>MAX)fail('OUTPUT_LIMIT')
   const saved=await openSource(bytes)
   if(saved.getPageCount()!==source.getPageCount())fail('PDF_DRAFT_INSERT_VERIFY_FAILED')
   assertPdfInsertFormPreserved(source,saved)
   if(action==='draftInsertsQuery'){const pages=await renderDraftPages(bytes,operation,signal),output=Buffer.from(JSON.stringify({pages}));check(signal);if(output.length>MAX)fail('OUTPUT_LIMIT');return {bytes:output,inputSha256:hash(original),sha256:hash(output),size:output.length}}
   return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfDraftInsertsSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}finally{busy=false}
 }}
}
