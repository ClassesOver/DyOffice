import {createHash} from 'node:crypto'
import {PDFName} from 'pdf-lib'
import {openEditablePdf} from './editable-document.mjs'
import {capturePdfManagedStamps,reapplyPdfManagedStamps,pdfStampsSafetyCodes} from './stamps-job.mjs'
const MAX=64*1024*1024,hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(Error(code),{code})}
const check=signal=>{if(signal?.aborted)fail('ABORTED')}
export const pdfReplacePagesSafetyCodes=new Set([...pdfStampsSafetyCodes,'INVALID_PDF_REPLACE_PAGES','INVALID_PDF_INSERT_PAGES','PDF_REPLACE_VERIFY_FAILED'])
export function validatePdfReplacePages(input){
 if(!Array.isArray(input)||input.length<1||input.length>100||input.some(page=>!Number.isSafeInteger(page)||page<1||page>100))fail('INVALID_PDF_REPLACE_PAGES')
 return [...new Set(input)].sort((a,b)=>a-b)
}
export function parsePdfReplacePagesRequest(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>65536)fail('INVALID_REQUEST')
 let value;try{value=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!value||value.version!==1)fail('INVALID_REQUEST')
 if(value.action==='replacePages'&&Object.keys(value).sort().join(',')==='action,pages,version')return validatePdfReplacePages(value.pages)
 if(value.action==='insertPages'&&Object.keys(value).sort().join(',')==='action,afterPageIndex,version'&&Number.isSafeInteger(value.afterPageIndex)&&value.afterPageIndex>=-1&&value.afterPageIndex<100)return {action:'insertPages',afterPageIndex:value.afterPageIndex}
 fail('INVALID_REQUEST')
}
export function framePdfReplacePages(target,source){
 if(!Buffer.isBuffer(target)||!Buffer.isBuffer(source)||!target.length||!source.length||target.length>MAX||source.length>MAX)fail('INPUT_LIMIT')
 const prefix=Buffer.alloc(4);prefix.writeUInt32BE(target.length);return Buffer.concat([prefix,target,source])
}
export function splitPdfReplacePagesFrame(frame){
 if(!Buffer.isBuffer(frame)||frame.length<6||frame.length>MAX*2+4)fail('INPUT_LIMIT')
 const length=frame.readUInt32BE(0),target=frame.subarray(4,4+length),source=frame.subarray(4+length)
 if(!length||length>MAX||target.length!==length||!source.length||source.length>MAX)fail('INPUT_LIMIT')
 return {target,source}
}
export function createPdfReplacePagesJob(){
 let busy=false
 return {async execute(frame,raw,signal){
  check(signal);if(busy)fail('BUSY');const {target,source}=splitPdfReplacePagesFrame(frame),selection=parsePdfReplacePagesRequest(raw);busy=true
  try{
   const targetDoc=await openEditablePdf(target),sourceDoc=await openEditablePdf(source)
   const pages=Array.isArray(selection)?selection:undefined,afterPageIndex='afterPageIndex'in selection?selection.afterPageIndex:undefined
   if(pages?.some(page=>page>targetDoc.getPageCount()))fail('INVALID_PDF_REPLACE_PAGES')
   if(afterPageIndex!==undefined&&afterPageIndex>=targetDoc.getPageCount())fail('INVALID_PDF_INSERT_PAGES')
   const count=targetDoc.getPageCount()-(pages?.length??0)+sourceDoc.getPageCount();if(count<1||count>100)fail('PDF_EDIT_LIMIT')
   const managed=await capturePdfManagedStamps(target);await capturePdfManagedStamps(source)
   // Imported managed overlays remain visible source content. Detach management
   // only: target's global config is reapplied separately over the final pages.
   for(const page of sourceDoc.getPages())page.node.delete(PDFName.of('DyOfficeStamps'))
   const imported=Buffer.from(await sourceDoc.save({useObjectStreams:false,addDefaultPage:false}));check(signal)
   const save=await import('../../../../pdf/src/main/save-pdf.ts')
   const result=pages
    ?await save.replacePagesBytes(managed.bytes,imported,pages.map(page=>page-1))
    :await save.insertPdfBytes(managed.bytes,imported,afterPageIndex)
   check(signal)
   const bytes=await reapplyPdfManagedStamps(Buffer.from(result.merged),managed.operations);check(signal)
   if(bytes.length>MAX)fail('OUTPUT_LIMIT')
   const inserted='inserted'in result?result.inserted:result.count
   if((await openEditablePdf(bytes)).getPageCount()!==count||pages&&result.removed!==pages.length||inserted!==sourceDoc.getPageCount())fail('PDF_REPLACE_VERIFY_FAILED')
   return {bytes,inputSha256:hash(target),sourceSha256:hash(source),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfReplacePagesSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}finally{busy=false}
 }}
}
