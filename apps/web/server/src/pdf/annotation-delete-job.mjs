import {PDFArray,PDFDict,PDFName,PDFRef} from '../../../../pdf/src/shared/pdf-lib.ts'
import {openEditablePdf} from './editable-document.mjs'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'

const MAX_BYTES=64*1024*1024,MAX_REQUEST=64*1024
const allowedSubtypes=new Set(['/Highlight','/Underline','/StrikeOut','/Squiggly','/Text'])
const refId=ref=>ref.objectNumber+'R'+(ref.generationNumber||'')

export function validatePdfAnnotationDeleteOperations(value){
 if(!Array.isArray(value)||value.length<1||value.length>100||Reflect.ownKeys(value).length!==value.length+1)fail('INVALID_PDF_ANNOTATION_DELETE')
 const operations=[],seen=new Set()
 for(let index=0;index<value.length;index++){
  const item=Object.getOwnPropertyDescriptor(value,String(index))
  if(!item||!('value'in item)||!item.enumerable)fail('INVALID_PDF_ANNOTATION_DELETE')
  const operation=item.value
  if(!operation||typeof operation!=='object'||Array.isArray(operation)||![Object.prototype,null].includes(Object.getPrototypeOf(operation)))fail('INVALID_PDF_ANNOTATION_DELETE')
  const keys=Reflect.ownKeys(operation)
  if(keys.length!==2||!keys.includes('page')||!keys.includes('annotationId'))fail('INVALID_PDF_ANNOTATION_DELETE')
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(operation,key);if(!property||!('value'in property)||!property.enumerable)fail('INVALID_PDF_ANNOTATION_DELETE')}
  const {page,annotationId}=operation
  if(!Number.isSafeInteger(page)||page<1||page>100||typeof annotationId!=='string'||!/^([1-9]\d{0,8})R([1-9]\d{0,4})?$/.test(annotationId)||seen.has(annotationId))fail('INVALID_PDF_ANNOTATION_DELETE')
  seen.add(annotationId);operations.push(Object.freeze({page,annotationId}))
 }
 return Object.freeze(operations)
}

export function parsePdfAnnotationDeleteRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw,'utf8')>MAX_REQUEST)fail('REQUEST_LIMIT')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(command,'deleteAnnotations','operations')
 return validatePdfAnnotationDeleteOperations(command.operations)
}

const safetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','OUTPUT_LIMIT'])

/** Exact deletion from the authorized base revision's standard Annots arrays.
 * Unlike the PC pending-edit pipeline, no object-number/rect fallback is needed:
 * the caller must supply the revision whose PDF.js IDs were read. Notes delete
 * their reply thread and popups; links, forms and direct dictionaries are refused. */
export function createPdfAnnotationDeleteJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfAnnotationDeleteRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   const doc=await openEditablePdf(original);check(signal)
   const pages=doc.getPages().map(page=>({page,annots:page.node.Annots(),entries:[]})),all=new Map()
   let count=0
   for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
    const page=pages[pageIndex]
    for(const ref of page.annots?.asArray()??[]){
     if(++count>10000)fail('PDF_EDIT_LIMIT')
     const dict=doc.context.lookup(ref),entry={ref,dict,id:ref instanceof PDFRef?refId(ref):null,pageIndex}
     page.entries.push(entry)
     if(entry.id)all.set(entry.id,[...(all.get(entry.id)??[]),entry])
    }
   }
   const removed=new Set()
   const select=entry=>{
    if(!entry.id||all.get(entry.id)?.length!==1||!(entry.dict instanceof PDFDict))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    removed.add(entry.id)
   }
   for(const operation of operations){
    const entry=pages[operation.page-1]?.entries.find(item=>item.id===operation.annotationId)
    if(!entry)fail('PDF_ANNOTATION_NOT_FOUND')
    const subtype=String(entry.dict?.get?.(PDFName.of('Subtype')))
    if(!allowedSubtypes.has(subtype)||subtype==='/Text'&&entry.dict.has(PDFName.of('IRT')))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    select(entry)
   }
   // Replies are transitive /IRT children. Popup children use /Parent; neither
   // relationship grants deletion authority for arbitrary annotation subtypes.
   let expanded=true
   while(expanded){
    expanded=false
    for(const entries of all.values())for(const entry of entries){
     if(removed.has(entry.id)||!(entry.dict instanceof PDFDict))continue
     const subtype=String(entry.dict.get(PDFName.of('Subtype')))
     const parent=entry.dict.get(PDFName.of(subtype==='/Popup'?'Parent':'IRT'))
     if(parent instanceof PDFRef&&removed.has(refId(parent))){
      if(!['/Text','/Popup'].includes(subtype))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
      select(entry);expanded=true
     }
    }
   }
   // A popup may be linked from the note without appearing in the page array.
   for(const id of [...removed]){
    const entry=all.get(id)[0],popup=entry.dict.get(PDFName.of('Popup'))
    if(popup instanceof PDFRef&&!removed.has(refId(popup))){
     const dict=doc.context.lookup(popup)
     if(!(dict instanceof PDFDict)||String(dict.get(PDFName.of('Subtype')))!=='/Popup'||String(dict.get(PDFName.of('Parent')))!==String(entry.ref))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
     if(all.has(refId(popup)))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
     removed.add(refId(popup));doc.context.delete(popup)
    }
   }
   const expected=[]
   for(const page of pages){
    expected.push(page.entries.filter(entry=>!removed.has(entry.id)).map(entry=>String(entry.ref)))
    for(let index=page.entries.length-1;index>=0;index--)if(removed.has(page.entries[index].id))page.annots.remove(index)
   }
   for(const id of removed){const entry=all.get(id)?.[0];if(entry)doc.context.delete(entry.ref)}
   check(signal)
   const bytes=Buffer.from(await doc.save({updateFieldAppearances:false}));check(signal)
   if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const reopened=await openEditablePdf(bytes);check(signal)
   for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
    const actual=(reopened.getPage(pageIndex).node.Annots()?.asArray()??[]).map(String)
    if(JSON.stringify(actual)!==JSON.stringify(expected[pageIndex]))fail('PDF_ANNOTATION_VERIFY_FAILED')
   }
   return {bytes,inputSha256,sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(safetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
