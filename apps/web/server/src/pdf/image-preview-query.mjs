import {PNG} from 'pngjs'
import {listPageImages,renderImagePng,renderPagePreviewPng} from '../../../../pdf/src/main/image-edit.ts'
import {openPdfForPendingEdits} from './pending-document.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
import {applyExistingImages} from './draft-inserts-job.mjs'
import {pdfImageBakesSafetyCodes,validatePdfImageBakeOperation} from './image-bakes-job.mjs'
import {hash} from './job-common.mjs'

function fail(code='INVALID_PDF_IMAGE_PREVIEW'){throw Object.assign(Error(code),{code})}
export const imagePreviewSafetyCodes=new Set([
 ...pdfImageBakesSafetyCodes,
 'INVALID_PDF_IMAGE_PREVIEW','MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT',
 'SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_STAMP_INTEGRITY_FAILED',
])
const finite=n=>Number.isFinite(n)&&Math.abs(n)<=100000
const rect=r=>Array.isArray(r)&&r.length===4&&r.every(finite)&&r[0]<r[2]&&r[1]<r[3]
const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max
function parse(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>32768)fail()
 let request;try{request=JSON.parse(raw)}catch{fail()}
 if(!request||Object.keys(request).sort().join(',')!=='action,operations,version'||request.version!==1||request.action!=='imagePreviewQuery')fail()
 const op=request.operations
 if(!op||typeof op!=='object'||Array.isArray(op))fail()
 const keys=Object.keys(op).sort().join(',')
 if(op.kind==='list'&&keys==='kind')return op
 if(!integer(op.pageIndex,0,99))fail()
 if(op.kind==='source'&&keys==='kind,pageIndex,rect,scale'&&rect(op.rect)&&integer(op.scale,1,3))return op
 if(op.kind!=='erase'||!['clip,excludeRects,kind,pageIndex,pxWidth,rotate','clip,excludeRects,imageBakes,kind,pageIndex,pxWidth,rotate'].includes(keys)||!integer(op.pxWidth,1,2800)||!integer(op.rotate,0,3)||
    !Array.isArray(op.excludeRects)||op.excludeRects.length<1||op.excludeRects.length>50||!op.excludeRects.every(rect))fail()
 const c=op.clip
 if(!c||Object.keys(c).sort().join(',')!=='height,width,x,y'||![c.x,c.y,c.width,c.height].every(finite)||
    c.x<0||c.y<0||c.width<=0||c.height<=0||op.pxWidth/c.width>16||c.height*op.pxWidth/c.width>2800)fail()
 if('imageBakes'in op){
  if(!Array.isArray(op.imageBakes)||op.imageBakes.length<1||op.imageBakes.length>20)fail()
  op.imageBakes=op.imageBakes.map(validatePdfImageBakeOperation)
  if(op.imageBakes.some(bake=>bake.page!==op.pageIndex+1)||new Set(op.imageBakes.map(bake=>bake.image_number)).size!==op.imageBakes.length)fail()
 }
 return op
}
function png(bgra,width,height){
 const rgba=Buffer.alloc(bgra.length)
 for(let i=0;i<rgba.length;i+=4){
  rgba[i]=bgra[i+2];rgba[i+1]=bgra[i+1];rgba[i+2]=bgra[i];rgba[i+3]=bgra[i+3]
 }
 return PNG.sync.write({width,height,data:rgba})
}
export function createIsolatedPdfImagePreviewQueryJob(){
 return createPdfProcessJob('imagePreviewQuery',parse,imagePreviewSafetyCodes)
}
export function createPdfImagePreviewQueryJob(){
 return {async execute(input,raw,signal){
  signal?.throwIfAborted()
  if(!Buffer.isBuffer(input)||!input.length||input.length>64*1024*1024)fail()
  const op=parse(raw),doc=await openPdfForPendingEdits(input)
  const refs=await listPageImages(input)
  if(refs.length>1000)fail('PDF_EDIT_LIMIT')
  signal?.throwIfAborted()
  const near=(ref,target)=>ref.rect.every((value,index)=>Math.abs(value-target[index])<=2)
  let result
  if(op.kind==='list'){
   result=refs.filter(ref=>refs.filter(other=>other.pageIndex===ref.pageIndex&&near(other,ref.rect)).length===1)
  }else{
   const page=doc.getPages()[op.pageIndex]
   if(!page||![page.getWidth(),page.getHeight()].every(value=>value>0&&value<=100000))fail()
   const targets=op.kind==='source'?[op.rect]:op.excludeRects
   const matched=targets.map(target=>refs.filter(ref=>ref.pageIndex===op.pageIndex&&near(ref,target)))
   if(matched.some(entries=>entries.length!==1)||new Set(matched.map(entries=>entries[0])).size!==targets.length)fail()
   if(op.kind==='source'){
    result=await renderImagePng(input,op.pageIndex,matched[0][0].rect,op.scale,png)
   }else{
    const excludeRects=matched.map(entries=>entries[0].rect)
    const working=op.imageBakes
     ?await applyExistingImages(input,op.imageBakes,signal,excludeRects.map(oldRect=>({pageIndex:op.pageIndex,oldRect})))
     :input
    if(working!==input){
     const updated=await listPageImages(working)
     if(excludeRects.some(target=>updated.filter(ref=>ref.pageIndex===op.pageIndex&&near(ref,target)).length!==1))fail()
    }
    result=await renderPagePreviewPng(working,{...op,excludeRects},png)
   }
  }
  signal?.throwIfAborted()
  const bytes=Buffer.from(JSON.stringify({result}))
  if(bytes.length>34*1024*1024)fail()
  return {bytes,inputSha256:hash(input),sha256:hash(bytes),size:bytes.length}
 }}
}
