import {preservePdfManagedStamps} from './stamps-job.mjs'
import {PDFArray,PDFDict,PDFName} from '../../../../pdf/src/shared/pdf-lib.ts'
import {openEditablePdf} from './editable-document.mjs'
import {pdfjsDocumentParams} from './pdfjs-open.mjs'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'

const MAX_BYTES=64*1024*1024,MAX_REQUEST=64*1024
const subtypes={highlight:'Highlight',underline:'Underline',strikeout:'StrikeOut',note:'Text'}

export function validatePdfAnnotationOperations(value){
 if(!Array.isArray(value)||value.length<1||value.length>20||Reflect.ownKeys(value).length!==value.length+1)fail('INVALID_PDF_ANNOTATION')
 const operations=[]
 for(let index=0;index<value.length;index++){
  const item=Object.getOwnPropertyDescriptor(value,String(index))
  if(!item||!('value'in item)||!item.enumerable)fail('INVALID_PDF_ANNOTATION')
  const operation=item.value
  if(!operation||typeof operation!=='object'||Array.isArray(operation)||![Object.prototype,null].includes(Object.getPrototypeOf(operation)))fail('INVALID_PDF_ANNOTATION')
  const keys=Reflect.ownKeys(operation)
  if(keys.some(key=>!['page','text','type','contents','occurrence'].includes(key))||!['page','text','type'].every(key=>keys.includes(key)))fail('INVALID_PDF_ANNOTATION')
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(operation,key);if(!property||!('value'in property)||!property.enumerable)fail('INVALID_PDF_ANNOTATION')}
  const {page,text,type,contents,occurrence=1}=operation
  if(!Number.isSafeInteger(page)||page<1||page>100||typeof text!=='string'||!text.trim()||text.length>2000||typeof type!=='string'||!Object.hasOwn(subtypes,type)||!Number.isSafeInteger(occurrence)||occurrence<1||occurrence>1000)fail('INVALID_PDF_ANNOTATION')
  if(type==='note'?(typeof contents!=='string'||!contents.trim()||contents.length>4000):contents!==undefined)fail('INVALID_PDF_ANNOTATION')
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text+(contents??'')))fail('INVALID_PDF_ANNOTATION')
  operations.push(Object.freeze({page,text,type,occurrence,...(type==='note'?{contents}:{})}))
 }
 return Object.freeze(operations)
}

export function parsePdfAnnotationRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw,'utf8')>MAX_REQUEST)fail('REQUEST_LIMIT')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(command,'annotateText','operations')
 return validatePdfAnnotationOperations(command.operations)
}


async function locateAnnotations(bytes,operations,signal){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const task=getDocument(pdfjsDocumentParams(bytes))
 try{
  const doc=await task.promise,located=[]
  for(const operation of operations){
   check(signal)
   if(operation.page>doc.numPages)fail('PDF_ANNOTATION_TEXT_NOT_FOUND')
   const page=await doc.getPage(operation.page),content=await page.getTextContent(),items=[]
   let text=''
   for(const item of content.items){
    if(typeof item.str!=='string')continue
    if(text.length+item.str.length>1000000)fail('PDF_EDIT_LIMIT')
    if(item.str&&item.transform)items.push({start:text.length,end:text.length+item.str.length,item})
    text+=item.str;if(item.hasEOL)text+='\n'
   }
   let start=-1,from=0
   for(let index=0;index<operation.occurrence;index++){start=text.indexOf(operation.text,from);if(start<0)fail('PDF_ANNOTATION_TEXT_NOT_FOUND');from=start+operation.text.length}
   const end=start+operation.text.length,quads=[]
   for(const {start:lo,end:hi,item}of items){
    if(hi<=start||lo>=end)continue
    const height=item.height||Math.hypot(item.transform[2],item.transform[3])
    // Match the PC search index's horizontal-run geometry. Vertical/tilted/RTL
    // text needs its richer quad mapping rather than misplaced annotations.
    if(item.dir==='rtl'||item.dir==='ttb'||Math.abs(item.transform[1])>height*0.001||item.transform[0]<=0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    const left=item.transform[4]+item.width*Math.max(0,start-lo)/item.str.length
    const right=item.transform[4]+item.width*Math.min(item.str.length,end-lo)/item.str.length
    const bottom=item.transform[5],top=bottom+height
    const quad=[left,top,right,top,left,bottom,right,bottom]
    if(!quad.every(Number.isFinite)||right<=left||height<=0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    quads.push(quad)
   }
   if(!quads.length)fail('PDF_ANNOTATION_TEXT_NOT_FOUND')
   located.push({operation,quads})
  }
  check(signal)
  return located
 }finally{await task.destroy()}
}

/** Shared anchor planning only: original PDF coordinates, no IDs and no PDF serialization. */
export async function planPdfAnnotations(bytes,operations,signal){
 check(signal)
 const validated=validatePdfAnnotationOperations(operations),located=await locateAnnotations(bytes,validated,signal),markups=[],notes=[]
 for(const {operation,quads}of located){
  const pageIndex=operation.page-1,color=[1,0.9,0.3]
  if(operation.type==='note')notes.push({kind:'note',pageIndex,color,at:[quads[0][0],quads[0][1]],contents:operation.contents})
  else markups.push({pageIndex,type:operation.type,color,quads})
 }
 check(signal)
 return {markups,notes}
}

const safetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_TEXT_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','OUTPUT_LIMIT'])

/** Private byte processor only. The authorized host must enforce process/resource
 * isolation and lease/base-revision fencing. Abort suppresses results at await
 * boundaries; it cannot preempt parser work inside this process. */
export function createPdfAnnotationJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfAnnotationRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   const source=await openEditablePdf(original);check(signal)
   const planned=await planPdfAnnotations(original,operations,signal)
   const request={path:'',markups:planned.markups,drawings:planned.notes,formValues:[],stamps:[],annotationAuthor:'AI Assistant'}
   const {applySaveRequest}=await import('../../../../pdf/src/main/save-pdf.ts')
   const result=await applySaveRequest(original,request);check(signal)
   const bytes=Buffer.from(result.bytes)
   if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const reopened=await openEditablePdf(bytes);check(signal)
   // The PC writer groups markups before drawings. Verify each appended standard
   // annotation after serialization instead of trusting an in-memory mutation.
   for(let pageIndex=0;pageIndex<source.getPageCount();pageIndex++){
    const before=source.getPage(pageIndex).node.Annots()?.size()??0
    const expected=[...request.markups,...request.drawings].filter(value=>value.pageIndex===pageIndex)
    const annots=reopened.getPage(pageIndex).node.Annots()
    if((annots?.size()??0)!==before+expected.length)fail('PDF_ANNOTATION_VERIFY_FAILED')
    for(let index=0;index<expected.length;index++){
     const input=expected[index],dict=reopened.context.lookup(annots.get(before+index)),type=input.kind==='note'?'note':input.type
     if(!(dict instanceof PDFDict)||String(dict.get(PDFName.of('Subtype')))!=='/'+subtypes[type]||!dict.has(PDFName.of('AP')))fail('PDF_ANNOTATION_VERIFY_FAILED')
     if(type==='note'&&dict.get(PDFName.of('Contents'))?.decodeText?.()!==input.contents)fail('PDF_ANNOTATION_VERIFY_FAILED')
     if(type!=='note'&&dict.lookup(PDFName.of('QuadPoints'),PDFArray).size()!==input.quads.length*8)fail('PDF_ANNOTATION_VERIFY_FAILED')
    }
   }
   const preserved=await preservePdfManagedStamps(original,bytes);
   return {bytes:preserved,inputSha256,sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(safetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
