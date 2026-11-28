import {PDFArray,PDFName} from '../../../../pdf/src/shared/pdf-lib.ts'
import {openEditablePdf} from './editable-document.mjs'
import {capturePdfManagedStamps,reapplyPdfManagedStamps,pdfStampsSafetyCodes} from './stamps-job.mjs'
import {openPdfForInserts,pdfInsertFormState} from './insert-form-integrity.mjs'
import {cleanupDeletedPageForms} from './deleted-page-forms.mjs'
import {detachPdfStampManagement} from '../../../../pdf/src/shared/managed-page-stamps.ts'
import {fail,hash} from './job-common.mjs'
const MAX=64*1024*1024
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
   const options={allowAcroForm:true}
   const managed=await capturePdfManagedStamps(target,options)
   const targetDoc=await openPdfForInserts(managed.bytes,{planning:true}),sourceDoc=await openPdfForInserts(source,{planning:true})
   const pages=Array.isArray(selection)?selection:undefined,afterPageIndex='afterPageIndex'in selection?selection.afterPageIndex:undefined
   if(pages?.some(page=>page>targetDoc.getPageCount()))fail('INVALID_PDF_REPLACE_PAGES')
   if(afterPageIndex!==undefined&&afterPageIndex>=targetDoc.getPageCount())fail('INVALID_PDF_INSERT_PAGES')
   const count=targetDoc.getPageCount()-(pages?.length??0)+sourceDoc.getPageCount();if(count<1||count>100)fail('PDF_EDIT_LIMIT')
   const formKey=PDFName.of('AcroForm'),targetForm=targetDoc.catalog.lookup(formKey),sourceHasForm=sourceDoc.catalog.has(formKey)
   if(pages&&targetForm){
    cleanupDeletedPageForms(targetDoc,pages.map(page=>String(targetDoc.getPage(page-1).ref)))
   }
   let combinesForms=false
   if(sourceHasForm&&targetForm){
    const roots=targetForm.lookup(PDFName.of('Fields'))
    if(!(roots instanceof PDFArray))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    combinesForms=roots.size()>0
    if(!combinesForms)targetDoc.catalog.delete(formKey)
   }
   const working=targetForm&&(pages||sourceHasForm)
    ?Buffer.from(await targetDoc.save({useObjectStreams:false,updateFieldAppearances:false})):managed.bytes
   const replaced=new Set(pages)
   const expectedPages=targetDoc.getPages().filter((_,index)=>!replaced.has(index+1))
   const at=pages?pages[0]-1:afterPageIndex+1
   // Project the single form tree onto its pages in the output. Pages from the other document have no widgets.
   let expectedForm=combinesForms?undefined:sourceHasForm
    ?pdfInsertFormState(sourceDoc,{pages:[...Array(at).fill(null),...sourceDoc.getPages(),...Array(expectedPages.length-at).fill(null)]})
    :pdfInsertFormState(targetDoc,{pages:[...expectedPages.slice(0,at),...Array(sourceDoc.getPageCount()).fill(null),...expectedPages.slice(at)]})
   // Imported managed overlays remain visible source content. Detach management
   // only: target's global config is reapplied separately over the final pages.
   detachPdfStampManagement(sourceDoc)
   const imported=Buffer.from(await sourceDoc.save({useObjectStreams:false,addDefaultPage:false,updateFieldAppearances:false}));check(signal)
   const save=await import('../../../../pdf/src/main/save-pdf.ts')
   const inspect=combinesForms?doc=>{expectedForm=pdfInsertFormState(doc)}:undefined
   const result=pages
    ?await save.replacePagesBytes(working,imported,pages.map(page=>page-1),inspect)
    :await save.insertPdfBytes(working,imported,afterPageIndex,inspect)
   check(signal)
   const bytes=await reapplyPdfManagedStamps(Buffer.from(result.merged),managed.operations,{...options,signal});check(signal)
   if(bytes.length>MAX)fail('OUTPUT_LIMIT')
   const inserted='inserted'in result?result.inserted:result.count
   const reopened=await openEditablePdf(bytes,options)
   if(reopened.getPageCount()!==count||pages&&result.removed!==pages.length||inserted!==sourceDoc.getPageCount()||pdfInsertFormState(reopened)!==expectedForm)fail('PDF_REPLACE_VERIFY_FAILED')
   return {bytes,inputSha256:hash(target),sourceSha256:hash(source),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfReplacePagesSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}finally{busy=false}
 }}
}
