import {preservePdfManagedStamps} from './stamps-job.mjs'
import {createHash} from 'node:crypto'
import {EncryptedPDFError,PDFArray,PDFDict,PDFDocument,PDFName} from 'pdf-lib'
import {pdfjsDocumentParams} from './pdfjs-open.mjs'

const MAX_BYTES=64*1024*1024,MAX_REQUEST=64*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}

export function validatePdfTextEditOperations(value){
 if(!Array.isArray(value)||value.length<1||value.length>20||Reflect.ownKeys(value).length!==value.length+1)fail('INVALID_PDF_TEXT_EDIT')
 const operations=[]
 for(let index=0;index<value.length;index++){
  const item=Object.getOwnPropertyDescriptor(value,String(index))
  if(!item||!('value'in item)||!item.enumerable)fail('INVALID_PDF_TEXT_EDIT')
  const operation=item.value
  if(!operation||typeof operation!=='object'||Array.isArray(operation)||![Object.prototype,null].includes(Object.getPrototypeOf(operation)))fail('INVALID_PDF_TEXT_EDIT')
  const keys=Reflect.ownKeys(operation)
  if(keys.some(key=>!['page','oldText','newText','occurrence'].includes(key))||!['page','oldText','newText'].every(key=>keys.includes(key)))fail('INVALID_PDF_TEXT_EDIT')
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(operation,key);if(!property||!('value'in property)||!property.enumerable)fail('INVALID_PDF_TEXT_EDIT')}
  const {page,oldText,newText,occurrence=1}=operation
  if(!Number.isSafeInteger(page)||page<1||page>100||typeof oldText!=='string'||!oldText.trim()||oldText.length>2000||typeof newText!=='string'||newText.length>4000||!Number.isSafeInteger(occurrence)||occurrence<1||occurrence>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(oldText+newText))fail('INVALID_PDF_TEXT_EDIT')
  operations.push(Object.freeze({page,oldText,newText,occurrence}))
 }
 return Object.freeze(operations)
}

export function parsePdfTextEditRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw,'utf8')>MAX_REQUEST)fail('REQUEST_LIMIT')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!command||Array.isArray(command)||Object.keys(command).sort().join(',')!=='action,operations,version'||command.version!==1||command.action!=='editText')fail('INVALID_REQUEST')
 return validatePdfTextEditOperations(command.operations)
}

async function editableDocument(bytes){
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail('MAGIC_MISMATCH')
 let doc
 try{doc=await PDFDocument.load(bytes,{updateMetadata:false})}
 catch(error){fail(error instanceof EncryptedPDFError||bytes.includes(Buffer.from('/Encrypt'))?'PASSWORD':'UNREADABLE')}
 if(doc.isEncrypted)fail('PASSWORD')
 if(doc.getPageCount()<1||doc.getPageCount()>100)fail('PDF_EDIT_LIMIT')
 const pending=doc.context.enumerateIndirectObjects().map(([,object])=>object),visited=new Set()
 while(pending.length){
  const object=pending.pop();if(!object||visited.has(object))continue
  visited.add(object);if(visited.size>100000)fail('PDF_EDIT_LIMIT')
  if(object instanceof PDFDict){
   if(String(object.get(PDFName.of('Type')))==='/Sig'||String(object.get(PDFName.of('FT')))==='/Sig'||object.has(PDFName.of('ByteRange')))fail('SIGNATURE_EDIT_REFUSED')
   pending.push(...object.values())
  }else if(object instanceof PDFArray)pending.push(...object.asArray())
  else if(object.dict instanceof PDFDict)pending.push(object.dict)
 }
 if(doc.catalog.has(PDFName.of('Perms')))fail('SIGNATURE_EDIT_REFUSED')
 if(doc.catalog.has(PDFName.of('AcroForm')))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 return doc
}

async function locate(bytes,operation){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const task=getDocument(pdfjsDocumentParams(bytes))
 try{
  const doc=await task.promise
  if(operation.page>doc.numPages)fail('PDF_TEXT_NOT_FOUND')
  const page=await doc.getPage(operation.page),content=await page.getTextContent(),items=[]
  let text=''
  for(const item of content.items){
   if(typeof item.str!=='string')continue
   if(text.length+item.str.length>1000000)fail('PDF_EDIT_LIMIT')
   if(item.str&&item.transform){const start=text.length;items.push({start,end:start+item.str.length,item})}
   text+=item.str;if(item.hasEOL)text+='\n'
  }
  let start=-1,from=0
  for(let n=0;n<operation.occurrence;n++){start=text.indexOf(operation.oldText,from);if(start<0)fail('PDF_TEXT_NOT_FOUND');from=start+operation.oldText.length}
  const end=start+operation.oldText.length,rects=[]
  let containerStart=start,containerEnd=end
  for(const {start:lo,end:hi,item}of items){
   if(hi<=start||lo>=end)continue
   const h=item.height||Math.hypot(item.transform[2],item.transform[3])
   // The PC editor locates horizontal runs by the same PDF.js item geometry.
   // Tilted baselines require its paragraph/rotation workflow, not this run edit.
   if(Math.abs(item.transform[1])>h*0.001)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
   // Replace the entire containing run. The PC fragment matcher searches inside
   // one native text object and can otherwise pick its first repeated substring,
   // even when PDF.js located the requested second occurrence geometrically.
   containerStart=Math.min(containerStart,lo);containerEnd=Math.max(containerEnd,hi)
   const x=item.transform[4],y=item.transform[5],width=item.width
   const rect=[x,y,x+width,y+h]
   if(rect.every(Number.isFinite)&&rect[2]>rect[0]&&h>0)rects.push(rect)
  }
  if(!rects.length)fail('PDF_TEXT_NOT_FOUND')
  const rect=[Math.min(...rects.map(r=>r[0])),Math.min(...rects.map(r=>r[1])),Math.max(...rects.map(r=>r[2])),Math.max(...rects.map(r=>r[3]))]
  // A short edit may span adjacent PDF text items, but not unrelated text lines.
  const height=Math.max(...rects.map(r=>r[3]-r[1]))
  if(rect[3]-rect[1]>height*1.5)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  return {pageIndex:operation.page-1,oldText:text.slice(containerStart,containerEnd),newText:text.slice(containerStart,start)+operation.newText+text.slice(end,containerEnd),rect,fontSize:height}
 }finally{await task.destroy()}
}

export const pdfTextEditSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_TEXT_NOT_FOUND','PDF_TEXT_EDIT_REFUSED','PDF_TEXT_VERIFY_FAILED','OUTPUT_LIMIT'])

/** Private byte processor only. The authorized host must enforce process/resource
 * isolation and lease/base-revision fencing. Abort suppresses the result at await
 * boundaries; it cannot preempt PDF.js/PDFium inside this process. */
export function createPdfTextEditJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfTextEditRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   await editableDocument(original);check(signal)
   const {applyTextEdits,validateTextEdits,verifyTextEdits}=await import('../../../../pdf/src/main/text-edit.ts')
   let bytes=original
   for(const operation of operations){
    const edit=await locate(bytes,operation);check(signal)
    const valid=await validateTextEdits(bytes,[edit]);check(signal)
    if(valid.length!==1||valid[0].reason!==null)fail('PDF_TEXT_EDIT_REFUSED')
    const result=await applyTextEdits(bytes,[edit]);check(signal)
    if(result.skipped.length)fail('PDF_TEXT_EDIT_REFUSED')
    bytes=Buffer.from(result.bytes)
    if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
    if((await verifyTextEdits(bytes,[edit])).length)fail('PDF_TEXT_VERIFY_FAILED')
    check(signal)
   }
   await editableDocument(bytes);check(signal)
   const preserved=await preservePdfManagedStamps(original,bytes);
   return {bytes:preserved,inputSha256,sha256:hash(preserved),size:preserved.length}
  }catch(error){check(signal);if(pdfTextEditSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
