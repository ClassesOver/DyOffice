import {preservePdfManagedStamps} from './stamps-job.mjs'
import {EncryptedPDFError,PDFDocument} from 'pdf-lib'
import {openPdfForPendingEdits} from './pending-document.mjs'
import {assertPdfInsertFormPreserved} from './insert-form-integrity.mjs'
import {pdfjsDocumentParams} from './pdfjs-open.mjs'
import {pdfRectToCss,viewToPdf,geomDispSize} from '../../../../pdf/src/renderer/annotations.ts'
import {concatMat,transformRect} from '../../../../pdf/src/main/form-text.ts'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'
const MAX_BYTES=64*1024*1024
export const pdfImageEditsSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_IMAGE_EDIT','PDF_IMAGE_NOT_FOUND','PDF_IMAGE_TARGET_OVERLAP','PDF_IMAGE_TARGET_AMBIGUOUS','PDF_IMAGE_EDIT_REFUSED','PDF_IMAGE_VERIFY_FAILED','PDF_FORM_INSERT_INTEGRITY_FAILED','OUTPUT_LIMIT'])
export function validatePdfImageEditOperations(input){
 if(!Array.isArray(input)||input.length<1||input.length>20||Reflect.ownKeys(input).length!==input.length+1)fail('INVALID_PDF_IMAGE_EDIT')
 const result=[]
 for(let index=0;index<input.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(index));if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)fail('INVALID_PDF_IMAGE_EDIT')
  const op=descriptor.value
  if(!op||typeof op!=='object'||Array.isArray(op)||![Object.prototype,null].includes(Object.getPrototypeOf(op))||!['transform_image','rotate_image','delete_image'].includes(op.op))fail('INVALID_PDF_IMAGE_EDIT')
  const allowed=['op','page','image_number',...(op.op==='transform_image'?['x','y','width','height','layer']:op.op==='rotate_image'?['direction']:[])]
  for(const key of Reflect.ownKeys(op)){const d=Object.getOwnPropertyDescriptor(op,key);if(!allowed.includes(key)||!d||!('value'in d)||!d.enumerable)fail('INVALID_PDF_IMAGE_EDIT')}
  if(!Number.isSafeInteger(op.page)||op.page<1||op.page>100||!Number.isSafeInteger(op.image_number)||op.image_number<1||op.image_number>1000)fail('INVALID_PDF_IMAGE_EDIT')
  for(const key of ['x','y','width','height'])if(key in op&&(typeof op[key]!=='number'||!Number.isFinite(op[key])||Math.abs(op[key])>100000||(['width','height'].includes(key)&&op[key]<=0)))fail('INVALID_PDF_IMAGE_EDIT')
  if(('layer'in op&&!['above_text','below_text'].includes(op.layer))||('direction'in op&&!['cw','ccw','180'].includes(op.direction)))fail('INVALID_PDF_IMAGE_EDIT')
  result.push(Object.freeze({...op}))
 }
 return Object.freeze(result)
}
export function parsePdfImageEditsRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST');if(Buffer.byteLength(raw)>65536)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(request,'imageEdits','operations')
 return validatePdfImageEditOperations(request.operations)
}
export function parsePdfImageQueryRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1024)fail('INVALID_REQUEST')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!request||Array.isArray(request)||Object.keys(request).sort().join(',')!=='action,operations,version'||request.version!==1||request.action!=='imageQuery'||!Array.isArray(request.operations)||request.operations.length)fail('INVALID_REQUEST')
 return []
}
async function readable(bytes){
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail('MAGIC_MISMATCH')
 let doc;try{doc=await PDFDocument.load(bytes,{updateMetadata:false})}catch(error){fail(error instanceof EncryptedPDFError||bytes.includes(Buffer.from('/Encrypt'))?'PASSWORD':'UNREADABLE')}
 if(doc.isEncrypted)fail('PASSWORD');if(doc.getPageCount()<1||doc.getPageCount()>100)fail('PDF_EDIT_LIMIT')
}
export async function catalog(bytes,signal){
 await readable(bytes);check(signal)
 const {listPageImages}=await import('../../../../pdf/src/main/image-edit.ts'),refs=await listPageImages(bytes);if(refs.length>1000)fail('PDF_EDIT_LIMIT');check(signal)
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),task=getDocument(pdfjsDocumentParams(bytes))
 try{
  const doc=await task.promise,entries=[],geometries=new Map()
  for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++){
   const page=await doc.getPage(pageNumber),view=page.view,unit=page.userUnit,rot=((page.rotate%360)+360)%360
   if(!Number.isFinite(unit)||unit<=0||unit>75000||!view.every(Number.isFinite)||view[2]<=view[0]||view[3]<=view[1]||![0,90,180,270].includes(rot))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
   const geom={pw:(view[2]-view[0])*unit,ph:(view[3]-view[1])*unit,x0:view[0],y0:view[1],rot,userUnit:unit};geometries.set(pageNumber,geom)
   const group=refs.filter(ref=>ref.pageIndex===pageNumber-1).map(ref=>({ref,box:pdfRectToCss(geom,ref.rect,1)})).sort((a,b)=>a.box.top-b.box.top||a.box.left-b.box.left)
   group.forEach(({ref,box},index)=>entries.push({ref,image:{page:pageNumber,image_number:index+1,x:box.left,y:box.top,width:box.width,height:box.height,layer:ref.aboveText?'above_text':'below_text'}}))
   check(signal)
  }
  return {entries,geometries}
 }finally{await task.destroy()}
}
export async function queryPdfImages(bytes,signal){return (await catalog(bytes,signal)).entries.map(entry=>entry.image)}
const near=(a,b,tolerance=2)=>a.every((value,index)=>Math.abs(value-b[index])<=tolerance)
const signature=item=>JSON.stringify([item.page,item.type,item.text,item.font,item.image,item.fill,item.stroke,item.size,item.mode])
const geometryEqual=(a,b)=>near(a.bounds,b.bounds,.05)&&near(a.matrix,b.matrix,.05)
function expectedTransform(item,edit){
 let matrix=item.matrix,bounds=[...item.bounds]
 const turn=((edit.quarterTurns??0)%4+4)%4
 if(turn){const cx=(bounds[0]+bounds[2])/2,cy=(bounds[1]+bounds[3])/2,[a,b,c,d]=[[1,0,0,1],[0,-1,1,0],[-1,0,0,-1],[0,1,-1,0]][turn],rotation=[a,b,c,d,cx-a*cx-c*cy,cy-b*cx-d*cy];matrix=concatMat(matrix,rotation);bounds=transformRect(bounds,rotation)}
 const sx=(edit.rect[2]-edit.rect[0])/(bounds[2]-bounds[0]),sy=(edit.rect[3]-edit.rect[1])/(bounds[3]-bounds[1]),move=[sx,0,0,sy,edit.rect[0]-sx*bounds[0],edit.rect[1]-sy*bounds[1]]
 return {...item,bounds:edit.rect,matrix:concatMat(matrix,move)}
}
export async function planPdfImageEdits(bytes,operations,signal){
 const {readPdfLeafObjects}=await import('../../../../pdf/src/main/text-edit.ts'),{entries,geometries}=await catalog(bytes,signal),objects=await readPdfLeafObjects(bytes),claimed=new Set(),planned=[]
 for(const operation of operations){
  const entry=entries.find(entry=>entry.image.page===operation.page&&entry.image.image_number===operation.image_number);if(!entry)fail('PDF_IMAGE_NOT_FOUND')
  const candidates=objects.map((object,index)=>({object,index})).filter(({object})=>object.page===operation.page-1&&object.type===3&&near(object.bounds,entry.ref.rect))
  if(candidates.length!==1)fail('PDF_IMAGE_TARGET_AMBIGUOUS')
  const target=candidates[0];if(claimed.has(target.index))fail('PDF_IMAGE_TARGET_OVERLAP');claimed.add(target.index)
  const geom=geometries.get(operation.page),size=geomDispSize(geom),cur=entry.image
  let edit
  if(operation.op==='delete_image')edit={kind:'deleteImage',pageIndex:operation.page-1,oldRect:entry.ref.rect}
  else if(operation.op==='rotate_image'){
   const turn=operation.direction==='ccw'?3:operation.direction==='180'?2:1,[x1,y1,x2,y2]=entry.ref.rect,rect=turn%2?[(x1+x2-y2+y1)/2,(y1+y2-x2+x1)/2,(x1+x2+y2-y1)/2,(y1+y2+x2-x1)/2]:[x1,y1,x2,y2]
   edit={kind:'transformImage',pageIndex:operation.page-1,oldRect:entry.ref.rect,rect,quarterTurns:turn}
  }else{
   let width=operation.width,height=operation.height
   if(width===undefined&&height===undefined){width=cur.width;height=cur.height}else{width??=height*cur.width/cur.height;height??=width*cur.height/cur.width}
   const k=Math.min(1,size.width/width,size.height/height);width*=k;height*=k
   const x=Math.min(Math.max(operation.x??cur.x,0),size.width-width),y=Math.min(Math.max(operation.y??cur.y,0),size.height-height),a=viewToPdf(geom,x,y),b=viewToPdf(geom,x+width,y+height),rect=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]
   edit={kind:'transformImage',pageIndex:operation.page-1,oldRect:entry.ref.rect,rect,...(operation.layer?{layer:operation.layer==='above_text'?'aboveText':'belowText'}:{})}
  }
  planned.push({edit,index:target.index,expected:edit.kind==='deleteImage'?null:expectedTransform(target.object,edit),layer:operation.layer})
 }
 // Native ops rematch by bounds. A prior result must never claim a later source image.
 for(let i=0;i<planned.length;i++)if(planned[i].expected)for(let j=i+1;j<planned.length;j++)if(planned[i].edit.pageIndex===planned[j].edit.pageIndex&&near(planned[i].expected.bounds,planned[j].edit.oldRect))fail('PDF_IMAGE_TARGET_AMBIGUOUS')
 return {objects,planned}
}
function verifyObjects(before,after,planned){
 const byIndex=new Map(planned.map(entry=>[entry.index,entry])),expected=before.flatMap((item,index)=>byIndex.has(index)?byIndex.get(index).expected?[byIndex.get(index).expected]:[]:[item])
 if(expected.length!==after.length)return false
 const available=[...after]
 for(const item of expected){const index=available.findIndex(other=>signature(item)===signature(other)&&geometryEqual(item,other));if(index<0)return false;available.splice(index,1)}
 // Preserve painting order of every untouched leaf object.
 const untouched=before.filter((_,index)=>!byIndex.has(index)),remaining=after.filter(item=>!planned.some(entry=>entry.expected&&signature(item)===signature(entry.expected)&&geometryEqual(item,entry.expected)))
 if(untouched.length!==remaining.length||untouched.some((item,index)=>signature(item)!==signature(remaining[index])||!geometryEqual(item,remaining[index])))return false
 for(const entry of planned){if(!entry.expected||!entry.layer)continue;const position=after.findIndex(item=>signature(item)===signature(entry.expected)&&geometryEqual(item,entry.expected)),firstText=after.findIndex(item=>item.page===entry.edit.pageIndex&&item.type===1);if(firstText>=0&&((entry.layer==='above_text'&&position<firstText)||(entry.layer==='below_text'&&position>firstText)))return false}
 return true
}
function createJob(query){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=query?parsePdfImageQueryRequest(raw):parsePdfImageEditsRequest(raw),original=Buffer.from(input);busy=true
  try{
   if(query){const images=await queryPdfImages(original,signal),bytes=Buffer.from(JSON.stringify({images}));return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}}
   const before=await openPdfForPendingEdits(original),plan=await planPdfImageEdits(original,operations,signal),{applySaveRequest}=await import('../../../../pdf/src/main/save-pdf.ts'),{readPdfLeafObjects}=await import('../../../../pdf/src/main/text-edit.ts')
   // Image geometry edits do not regenerate form widget appearances.
   const applied=await applySaveRequest(original,{formValues:[],markups:[],drawings:[],rotations:[],imageEdits:plan.planned.map(item=>item.edit)},{updateFieldAppearances:()=>{}});check(signal)
   if(applied.skippedImageEdits.length)fail('PDF_IMAGE_EDIT_REFUSED')
   const bytes=Buffer.from(applied.bytes);if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   if(!verifyObjects(plan.objects,await readPdfLeafObjects(bytes),plan.planned))fail('PDF_IMAGE_VERIFY_FAILED')
   const preserved=await preservePdfManagedStamps(original,bytes,{allowAcroForm:true})
   const after=await openPdfForPendingEdits(preserved)
   if(after.getPageCount()!==before.getPageCount())fail('PDF_IMAGE_VERIFY_FAILED')
   assertPdfInsertFormPreserved(before,after);check(signal)
   return {bytes:preserved,inputSha256:hash(original),sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(pdfImageEditsSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
export function createPdfImageEditsJob(){return createJob(false)}
export function createPdfImageQueryJob(){return createJob(true)}
