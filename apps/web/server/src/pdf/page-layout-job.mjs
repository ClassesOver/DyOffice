import {capturePdfManagedStamps,reapplyPdfManagedStamps,pdfStampsSafetyCodes} from './stamps-job.mjs'
import {PDFName} from 'pdf-lib'
import {openEditablePdf} from './editable-document.mjs'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'
const MAX_BYTES=64*1024*1024
export const pdfPageLayoutSafetyCodes=new Set([...pdfStampsSafetyCodes,'MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_PAGE_LAYOUT','PDF_PAGE_LAYOUT_VERIFY_FAILED','OUTPUT_LIMIT'])
export function validatePdfPageLayout(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('INVALID_PDF_PAGE_LAYOUT')
 for(const key of Reflect.ownKeys(value)){const property=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!property||!('value'in property)||!property.enumerable)fail('INVALID_PDF_PAGE_LAYOUT')}
 if(value.kind==='split'&&Object.keys(value).sort().join(',')==='kind,perPage'&&[2,4,9].includes(value.perPage))return Object.freeze({kind:'split',perPage:value.perPage})
 if(value.kind==='merge'&&Object.keys(value).sort().join(',')==='direction,kind,perSheet,separator'&&Number.isSafeInteger(value.perSheet)&&value.perSheet>=2&&value.perSheet<=16&&['horizontal','vertical'].includes(value.direction)&&typeof value.separator==='boolean')return Object.freeze({kind:'merge',perSheet:value.perSheet,direction:value.direction,separator:value.separator})
 fail('INVALID_PDF_PAGE_LAYOUT')
}
export function parsePdfPageLayoutRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>4096)fail('INVALID_REQUEST')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(command,'pageLayout','operation')
 return validatePdfPageLayout(command.operation)
}
const annotations=page=>(page.node.Annots()?.asArray()??[]).map(ref=>{
 const dict=page.doc.context.lookup(ref)
 return ['Subtype','Contents','T'].map(key=>String(dict?.get?.(PDFName.of(key))))
})
function viewBox(page){
 const media=page.getMediaBox(),crop=page.getCropBox(),x=Math.max(media.x,crop.x),y=Math.max(media.y,crop.y),right=Math.min(media.x+media.width,crop.x+crop.width),top=Math.min(media.y+media.height,crop.y+crop.height)
 return right>x&&top>y?{x,y,width:right-x,height:top-y}:media
}
export function createPdfPageLayoutJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operation=parsePdfPageLayoutRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   const managed=await capturePdfManagedStamps(original),working=managed.bytes,source=await openEditablePdf(working);check(signal)
   const pages=source.getPages(),expectedCount=operation.kind==='split'?pages.length*operation.perPage:Math.ceil(pages.length/operation.perSheet)
   if(expectedCount>100)fail('PDF_EDIT_LIMIT')
   for(const page of pages){
    for(const box of [page.getMediaBox(),page.getCropBox()])if(!Object.values(box).every(Number.isFinite)||box.width<=0||box.height<=0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    if(!Number.isFinite(page.getRotation().angle)||page.getRotation().angle%90!==0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
   }
   const {splitPagesBytes,mergePagesBytes,mergeGrid}=await import('../../../../pdf/src/main/save-pdf.ts')
   let bytes=Buffer.from(operation.kind==='split'?await splitPagesBytes(working,operation.perPage):await mergePagesBytes(working,operation));check(signal)
   if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const reopened=await openEditablePdf(bytes);check(signal)
   if(reopened.getPageCount()!==expectedCount)fail('PDF_PAGE_LAYOUT_VERIFY_FAILED')
   if(operation.kind==='split'){
    const {cols,rows}=mergeGrid(operation.perPage)
    for(let index=0;index<expectedCount;index++){
     const before=pages[Math.floor(index/operation.perPage)],after=reopened.getPage(index),rot=((before.getRotation().angle%360)+360)%360,crop=viewBox(before),turns=rot===90||rot===270
     const expectedW=crop.width/(turns?rows:cols),expectedH=crop.height/(turns?cols:rows)
     if(after.getRotation().angle!==before.getRotation().angle||Math.abs(after.getWidth()-expectedW)>1e-7||Math.abs(after.getHeight()-expectedH)>1e-7||JSON.stringify(annotations(after))!==JSON.stringify(annotations(before)))fail('PDF_PAGE_LAYOUT_VERIFY_FAILED')
    }
   }else{
    const first=pages[0],crop=viewBox(first),turns=((first.getRotation().angle%180)+180)%180===90,displayW=turns?crop.height:crop.width,displayH=turns?crop.width:crop.height
    for(const after of reopened.getPages()){
     if(after.getWidth()!==(operation.perSheet===2?displayH:displayW)||after.getHeight()!==(operation.perSheet===2?displayW:displayH)||after.getRotation().angle!==0||annotations(after).length)fail('PDF_PAGE_LAYOUT_VERIFY_FAILED')
    }
   }
   bytes=await reapplyPdfManagedStamps(bytes,managed.operations);check(signal)
   if(bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   return {bytes,inputSha256,sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfPageLayoutSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
