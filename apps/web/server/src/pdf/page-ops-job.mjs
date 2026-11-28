import {capturePdfManagedStamps,reapplyPdfManagedStamps,pdfStampsSafetyCodes} from './stamps-job.mjs'
import {PDFArray,PDFDict,PDFName,PDFNumber} from 'pdf-lib'
import {openEditablePdf} from './editable-document.mjs'
import {hasUnsupportedPdfForm} from '../../../shared/pdf-edit-structure.mjs'
import {pdfInsertFormState} from './insert-form-integrity.mjs'

const MAX_BYTES=64*1024*1024,MAX_REQUEST=64*1024
const annotationRefs=page=>JSON.stringify((page.node.Annots()?.asArray()??[]).map(String))
export const pdfPageOpsSafetyCodes=new Set([...pdfStampsSafetyCodes,'MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_PAGE_OPS','PDF_PAGE_OPS_VERIFY_FAILED','OUTPUT_LIMIT'])
export {validatePdfPageOperations} from '../../../../../packages/web-contracts/src/pdf-page-ops.ts'
import {validatePdfPageOperations} from '../../../../../packages/web-contracts/src/pdf-page-ops.ts'
import {fail,check,hash,requireEnvelope} from './job-common.mjs'
export function parsePdfPageOpsRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw,'utf8')>MAX_REQUEST)fail('REQUEST_LIMIT')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(command,'pageOps','operations')
 return validatePdfPageOperations(command.operations)
}

const isWidget=dict=>dict instanceof PDFDict&&String(dict.lookup(PDFName.of('Subtype')))==='/Widget'
function widgetRect(widget){
 const rect=widget.lookup(PDFName.of('Rect'))
 if(!(rect instanceof PDFArray)||rect.size()!==4)fail('PDF_PAGE_OPS_VERIFY_FAILED')
 const coordinates=rect.asArray().map((_,index)=>rect.lookup(index))
 if(!coordinates.every(value=>value instanceof PDFNumber&&Number.isFinite(value.asNumber())))fail('PDF_PAGE_OPS_VERIFY_FAILED')
 return coordinates.map(value=>value.asNumber())
}
function verifyWidgetScale(before,after,k){
 for(const ref of before.node.Annots()?.asArray()??[]){
  const source=before.doc.context.lookup(ref)
  if(!isWidget(source))continue
  const output=after.doc.context.lookup(ref)
  if(!isWidget(output))fail('PDF_PAGE_OPS_VERIFY_FAILED')
  const initial=widgetRect(source),scaled=widgetRect(output)
  if(scaled.some((value,index)=>Math.abs(value-initial[index]*k)>1e-7))fail('PDF_PAGE_OPS_VERIFY_FAILED')
 }
}

async function geometryBytes(original,doc,operation,signal){
 const source=doc.getPages(),hasForm=doc.catalog.has(PDFName.of('AcroForm'))
 const formOptions={ignoreAttachedWidgetRects:operation.op==='setPageSize'}
 const formState=hasForm?pdfInsertFormState(doc,formOptions):null
 for(const page of source){
  for(const box of [page.getMediaBox(),page.getCropBox()])if(!Object.values(box).every(Number.isFinite)||box.width<=0||box.height<=0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  if(!Number.isFinite(page.getRotation().angle)||page.getRotation().angle%90!==0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 }
 const {setPageSizeBytes,cropPagesBytes}=await import('../../../../pdf/src/main/save-pdf.ts')
 const bytes=Buffer.from(operation.op==='setPageSize'
  ?await setPageSizeBytes(original,operation.width,operation.height)
  :await cropPagesBytes(original,operation.pages.map(page=>page-1),{l:operation.left,t:operation.top,r:operation.right,b:operation.bottom}))
 check(signal)
 if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
 const reopened=await openEditablePdf(bytes,{allowAcroForm:true});check(signal)
 if(reopened.getPageCount()!==source.length)fail('PDF_PAGE_OPS_VERIFY_FAILED')
 if(formState!==null&&pdfInsertFormState(reopened,formOptions)!==formState)fail('PDF_PAGE_OPS_VERIFY_FAILED')
 for(let index=0;index<source.length;index++){
  const before=source[index],after=reopened.getPage(index)
  if(String(after.ref)!==String(before.ref)||after.getRotation().angle!==before.getRotation().angle||annotationRefs(after)!==annotationRefs(before))fail('PDF_PAGE_OPS_VERIFY_FAILED')
  if(operation.op==='setPageSize'){
   const rotated=((after.getRotation().angle%180)+180)%180===90
   if(after.getWidth()!==(rotated?operation.height:operation.width)||after.getHeight()!==(rotated?operation.width:operation.height))fail('PDF_PAGE_OPS_VERIFY_FAILED')
   if(hasForm)verifyWidgetScale(before,after,Math.min(after.getWidth()/before.getWidth(),after.getHeight()/before.getHeight()))
  }else{
   // CropBox affects viewing only: all content streams and annotation dictionaries must remain.
   if(JSON.stringify(after.getMediaBox())!==JSON.stringify(before.getMediaBox())||String(after.node.get(PDFName.of('Contents')))!==String(before.node.get(PDFName.of('Contents'))))fail('PDF_PAGE_OPS_VERIFY_FAILED')
   for(const ref of before.node.Annots()?.asArray()??[])if(String(before.doc.context.lookup(ref))!==String(reopened.context.lookup(ref)))fail('PDF_PAGE_OPS_VERIFY_FAILED')
   const old=before.getCropBox(),actual=after.getCropBox()
   if(operation.pages.includes(index+1)){
    const rotated=((after.getRotation().angle%180)+180)%180===90
    const width=old.width*(rotated?operation.bottom-operation.top:operation.right-operation.left)
    const height=old.height*(rotated?operation.right-operation.left:operation.bottom-operation.top)
    if(Math.abs(actual.width-width)>1e-7||Math.abs(actual.height-height)>1e-7)fail('PDF_PAGE_OPS_VERIFY_FAILED')
   }else if(JSON.stringify(actual)!==JSON.stringify(old))fail('PDF_PAGE_OPS_VERIFY_FAILED')
  }
 }
 return {bytes,reopened}
}

export function createPdfPageOpsJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfPageOpsRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   const geometry=operations[0].op==='setPageSize'||operations[0].op==='cropPages'
   const options={allowAcroForm:geometry}
   const managed=await capturePdfManagedStamps(original,options),working=managed.bytes,doc=await openEditablePdf(working,options);check(signal)
   if(geometry&&hasUnsupportedPdfForm(doc))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
   const source=doc.getPages(),count=source.length,deleted=new Set(),rotation=new Map(),inserts=[]
   validatePdfPageOperations(operations,count)
   if(geometry){
    const adjusted=await geometryBytes(working,doc,operations[0],signal)
    const bytes=await reapplyPdfManagedStamps(adjusted.bytes,managed.operations,{...options,signal})
    if(managed.operations.length&&doc.catalog.has(PDFName.of('AcroForm'))){
     const final=await openEditablePdf(bytes,options)
     if(pdfInsertFormState(adjusted.reopened)!==pdfInsertFormState(final))fail('PDF_PAGE_OPS_VERIFY_FAILED')
    }
    check(signal);if(bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
    return {bytes,inputSha256,sha256:hash(bytes),size:bytes.length}
   }
   let requestedOrder=null,metadata=null
   for(const op of operations){
    if(op.op==='rotatePages')for(const page of op.pages)rotation.set(page,(rotation.get(page)??0)+op.dir)
    else if(op.op==='deletePage')deleted.add(op.page)
    else if(op.op==='setPageOrder')requestedOrder=op.order
    else if(op.op==='setMetadata')metadata=op.metadata===null?null:{...metadata,...op.metadata}
    else inserts.push(op.afterPage)
   }
   const remaining=Array.from({length:count},(_,i)=>i+1).filter(page=>!deleted.has(page))
   const order=requestedOrder?.filter(page=>!deleted.has(page))??remaining
   const {applySaveRequest,insertBlankPageBytes}=await import('../../../../pdf/src/main/save-pdf.ts')
   const result=await applySaveRequest(working,{path:'',metadata,markups:[],drawings:[],formValues:[],stamps:[],rotations:[...rotation].map(([page,delta])=>({pageIndex:page-1,delta:((delta%360)+360)%360})),deletedPages:[...deleted].map(page=>page-1),pageOrder:order.map(page=>page-1)})
   let bytes=Buffer.from(result.bytes);check(signal)
   const layout=order.map(page=>({page}))
   for(const anchor of inserts){
    let index=anchor===0?-1:layout.findIndex(item=>item.page===anchor)
    // Repeated inserts at one original anchor retain request order.
    while(layout[index+1]?.anchor===anchor)index++
    const neighbor=layout[Math.max(index,0)],originalPage=neighbor.page?source[neighbor.page-1]:neighbor.neighbor
    const current=await openEditablePdf(bytes)
    const currentNeighbor=current.getPage(Math.max(index,0))
    const expected={anchor,neighbor:originalPage,angle:currentNeighbor.getRotation().angle}
    bytes=Buffer.from(await insertBlankPageBytes(bytes,index));check(signal)
    layout.splice(index+1,0,expected)
   }
   if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const reopened=await openEditablePdf(bytes);check(signal)
   if(metadata){
    const getters={title:'getTitle',author:'getAuthor',subject:'getSubject',keywords:'getKeywords'}
    for(const [key,getter]of Object.entries(getters)){
     const value=metadata[key],expected=value===undefined?(doc[getter]()??''):key==='keywords'?value.split(/[,，;；]/).map(part=>part.trim()).filter(Boolean).join(' '):value
     if((reopened[getter]()??'')!==expected)fail('PDF_PAGE_OPS_VERIFY_FAILED')
    }
   }
   if(reopened.getPageCount()!==layout.length)fail('PDF_PAGE_OPS_VERIFY_FAILED')
   for(let index=0;index<layout.length;index++){
    const item=layout[index],actual=reopened.getPage(index),before=item.page?source[item.page-1]:item.neighbor
    const delta=item.page?(rotation.get(item.page)??0):0
    // Page references and annotation references remain stable through the PC in-memory writer.
    if(item.page&&(String(actual.ref)!==String(before.ref)||String(actual.node.get(PDFName.of('Contents')))!==String(before.node.get(PDFName.of('Contents')))||String(actual.node.get(PDFName.of('Annots')))!==String(before.node.get(PDFName.of('Annots')))))fail('PDF_PAGE_OPS_VERIFY_FAILED')
    if(actual.getWidth()!==before.getWidth()||actual.getHeight()!==before.getHeight())fail('PDF_PAGE_OPS_VERIFY_FAILED')
    if(item.page&&((actual.getRotation().angle%360)+360)%360!==((before.getRotation().angle+delta)%360+360)%360)fail('PDF_PAGE_OPS_VERIFY_FAILED')
    if(!item.page&&actual.getRotation().angle!==item.angle)fail('PDF_PAGE_OPS_VERIFY_FAILED')
    if(!item.page&&(actual.node.has(PDFName.of('Contents'))||actual.node.has(PDFName.of('Annots'))))fail('PDF_PAGE_OPS_VERIFY_FAILED')
   }
   bytes=await reapplyPdfManagedStamps(bytes,managed.operations);check(signal)
   if(bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   return {bytes,inputSha256,sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfPageOpsSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
