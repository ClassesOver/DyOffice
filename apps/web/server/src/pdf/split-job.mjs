import {capturePdfManagedStamps,reapplyPdfManagedStamps,pdfStampsSafetyCodes} from './stamps-job.mjs'
import {createHash} from 'node:crypto'
import {PDFName} from 'pdf-lib'
import {openEditablePdf} from './editable-document.mjs'
const MAX_BYTES=64*1024*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
export const pdfSplitSafetyCodes=new Set([...pdfStampsSafetyCodes,'MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_SPLIT','PDF_SPLIT_VERIFY_FAILED','OUTPUT_LIMIT'])
export function validatePdfSplitSize(value){
 if(!Number.isSafeInteger(value)||value<1||value>100)fail('INVALID_PDF_SPLIT')
 return value
}
export function parsePdfSplitRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>4096)fail('INVALID_REQUEST')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!command||Array.isArray(command)||Object.keys(command).sort().join(',')!=='action,pagesPerFile,version'||command.version!==1||command.action!=='splitPdf')fail('INVALID_REQUEST')
 return validatePdfSplitSize(command.pagesPerFile)
}
const notes=page=>(page.node.Annots()?.asArray()??[]).map(ref=>{
 const dict=page.doc.context.lookup(ref)
 return ['Subtype','Contents','T'].map(key=>String(dict?.get?.(PDFName.of(key))))
})
export function createPdfSplitJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const pagesPerFile=parsePdfSplitRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   const managed=await capturePdfManagedStamps(original),working=managed.bytes,source=await openEditablePdf(working);check(signal)
   const count=source.getPageCount(),parts=Math.ceil(count/pagesPerFile)
   if(parts<2||parts>100)fail('INVALID_PDF_SPLIT')
   const {splitPdfBytes}=await import('../../../../pdf/src/main/save-pdf.ts')
   const outputs=await splitPdfBytes(working,pagesPerFile);check(signal)
   if(outputs.length!==parts)fail('PDF_SPLIT_VERIFY_FAILED')
   let total=0
   const files=[]
   for(let index=0;index<outputs.length;index++){
    let bytes=Buffer.from(outputs[index])
    if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
    const reopened=await openEditablePdf(bytes);check(signal)
    if(reopened.getPageCount()!==Math.min(pagesPerFile,count-index*pagesPerFile))fail('PDF_SPLIT_VERIFY_FAILED')
    for(let page=0;page<reopened.getPageCount();page++){
     const before=source.getPage(index*pagesPerFile+page),after=reopened.getPage(page)
     if(JSON.stringify(before.getMediaBox())!==JSON.stringify(after.getMediaBox())||JSON.stringify(before.getCropBox())!==JSON.stringify(after.getCropBox())||before.getRotation().angle!==after.getRotation().angle||JSON.stringify(notes(before))!==JSON.stringify(notes(after)))fail('PDF_SPLIT_VERIFY_FAILED')
    }
    bytes=await reapplyPdfManagedStamps(bytes,managed.operations);check(signal);total+=bytes.length
    if(total>MAX_BYTES)fail('OUTPUT_LIMIT')
    files.push({bytes,sha256:hash(bytes),size:bytes.length})
   }
   return {inputSha256,files}
  }catch(error){check(signal);if(pdfSplitSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
