import {capturePdfManagedStamps,reapplyPdfManagedStamps,pdfStampsSafetyCodes} from './stamps-job.mjs'
import {PDFName} from 'pdf-lib'
import {openEditablePdf} from './editable-document.mjs'
import {openPdfForInserts} from './insert-form-integrity.mjs'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'
const MAX_BYTES=64*1024*1024
export const pdfExtractSafetyCodes=new Set([...pdfStampsSafetyCodes,'MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_EXTRACT_PAGES','PDF_EXTRACT_VERIFY_FAILED','OUTPUT_LIMIT'])
export function validatePdfExtractPages(value){
 if(!Array.isArray(value)||value.length<1||value.length>100||Reflect.ownKeys(value).length!==value.length+1)fail('INVALID_PDF_EXTRACT_PAGES')
 const pages=[]
 for(let index=0;index<value.length;index++){
  const property=Object.getOwnPropertyDescriptor(value,String(index)),page=property?.value
  if(!property||!('value'in property)||!property.enumerable||!Number.isSafeInteger(page)||page<1||page>100||pages.includes(page))fail('INVALID_PDF_EXTRACT_PAGES')
  pages.push(page)
 }
 return Object.freeze(pages)
}
export function parsePdfExtractPagesRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>4096)fail('INVALID_REQUEST')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(command,'extractPages','pages')
 return validatePdfExtractPages(command.pages)
}
function annotations(page){
 return (page.node.Annots()?.asArray()??[]).map(ref=>{
  const dict=page.doc.context.lookup(ref)
  return ['Subtype','Contents','T'].map(key=>String(dict?.get?.(PDFName.of(key))))
 })
}
export function createPdfExtractPagesJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const pages=parsePdfExtractPagesRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   const managed=await capturePdfManagedStamps(original,{allowAcroForm:true}),working=managed.bytes
   const source=await openPdfForInserts(working,{planning:true});check(signal)
   if(pages.some(page=>page>source.getPageCount()))fail('INVALID_PDF_EXTRACT_PAGES')
   const {extractPagesBytes}=await import('../../../../pdf/src/main/save-pdf.ts')
   let bytes=Buffer.from(await extractPagesBytes(working,pages.map(page=>page-1)));check(signal)
   if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const reopened=await openEditablePdf(bytes,{allowAcroForm:true});check(signal)
   if(reopened.getPageCount()!==pages.length)fail('PDF_EXTRACT_VERIFY_FAILED')
   for(let index=0;index<pages.length;index++){
    const before=source.getPage(pages[index]-1),after=reopened.getPage(index)
    if(JSON.stringify(before.getMediaBox())!==JSON.stringify(after.getMediaBox())||JSON.stringify(before.getCropBox())!==JSON.stringify(after.getCropBox())||before.getRotation().angle!==after.getRotation().angle||JSON.stringify(annotations(before))!==JSON.stringify(annotations(after)))fail('PDF_EXTRACT_VERIFY_FAILED')
   }
   bytes=await reapplyPdfManagedStamps(bytes,managed.operations,{allowAcroForm:true,signal});check(signal)
   if(bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   return {bytes,inputSha256,sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfExtractSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
