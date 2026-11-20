import {createHash} from 'node:crypto'
import {PDFDict,PDFHexString,PDFName,PDFRef,PDFString} from 'pdf-lib'
import {openEditablePdf} from './editable-document.mjs'

const MAX_BYTES=64*1024*1024,MAX_REQUEST=512*1024
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
const refId=ref=>ref.objectNumber+'R'+(ref.generationNumber||'')
export const pdfNoteUpdateSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','OUTPUT_LIMIT'])

export function validatePdfNoteUpdateOperations(value){
 if(!Array.isArray(value)||value.length<1||value.length>100||Reflect.ownKeys(value).length!==value.length+1)fail('INVALID_PDF_NOTE_UPDATE')
 const operations=[],edited=new Set()
 for(let index=0;index<value.length;index++){
  const item=Object.getOwnPropertyDescriptor(value,String(index))
  if(!item||!('value'in item)||!item.enumerable)fail('INVALID_PDF_NOTE_UPDATE')
  const operation=item.value
  if(!operation||typeof operation!=='object'||Array.isArray(operation)||![Object.prototype,null].includes(Object.getPrototypeOf(operation)))fail('INVALID_PDF_NOTE_UPDATE')
  const keys=Reflect.ownKeys(operation)
  if(keys.length!==4||!['page','annotationId','action','text'].every(key=>keys.includes(key)))fail('INVALID_PDF_NOTE_UPDATE')
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(operation,key);if(!property||!('value'in property)||!property.enumerable)fail('INVALID_PDF_NOTE_UPDATE')}
  const {page,annotationId,action,text}=operation
  if(!Number.isSafeInteger(page)||page<1||page>100||typeof annotationId!=='string'||!/^([1-9]\d{0,8})R([1-9]\d{0,4})?$/.test(annotationId)||!['reply','edit'].includes(action)||typeof text!=='string'||!text.trim()||text.length>4000||text.includes('\0'))fail('INVALID_PDF_NOTE_UPDATE')
  if(action==='edit'){if(edited.has(annotationId))fail('INVALID_PDF_NOTE_UPDATE');edited.add(annotationId)}
  operations.push(Object.freeze({page,annotationId,action,text:text.trim()}))
 }
 return Object.freeze(operations)
}

export function parsePdfNoteUpdateRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw,'utf8')>MAX_REQUEST)fail('REQUEST_LIMIT')
 let command;try{command=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!command||Array.isArray(command)||Object.keys(command).sort().join(',')!=='action,operations,version'||command.version!==1||command.action!=='updateNotes')fail('INVALID_REQUEST')
 return validatePdfNoteUpdateOperations(command.operations)
}

/** Mutate only exact Text annotations from the authorized base revision. */
export function createPdfNoteUpdateJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfNoteUpdateRequest(raw),original=Buffer.from(input),inputSha256=hash(original)
  busy=true
  try{
   const doc=await openEditablePdf(original);check(signal)
   const pages=doc.getPages(),all=new Map()
   let count=0
   for(let pageIndex=0;pageIndex<pages.length;pageIndex++)for(const ref of pages[pageIndex].node.Annots()?.asArray()??[]){
    if(++count>10000)fail('PDF_EDIT_LIMIT')
    if(!(ref instanceof PDFRef))continue
    const id=refId(ref),entry={ref,dict:doc.context.lookup(ref),pageIndex}
    all.set(id,[...(all.get(id)??[]),entry])
   }
   const targets=operations.map(operation=>{
    const entries=all.get(operation.annotationId)
    const entry=entries?.find(entry=>entry.pageIndex===operation.page-1)
    if(!entry)fail('PDF_ANNOTATION_NOT_FOUND')
    if(entries.length!==1||!(entry.dict instanceof PDFDict)||String(entry.dict.get(PDFName.of('Subtype')))!=='/Text')fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    if(operation.action==='reply'&&entry.dict.has(PDFName.of('IRT')))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    // Reply targets must be standard positioned notes, not malformed dictionaries.
    if(operation.action==='reply'){
     const rect=entry.dict.lookup(PDFName.of('Rect'))
     if(!rect?.asArray||rect.size()!==4||!rect.asArray().every(value=>typeof value?.asNumber==='function'&&Number.isFinite(value.asNumber())))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
     const [x0,y0,x1,y1]=rect.asArray().map(value=>value.asNumber())
     if(x1<=x0||y1<=y0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
    }
    return {operation,...entry}
   })
   const when=PDFString.of(new Date().toISOString().replace(/^(.{4})-(.{2})-(.{2})T(.{2}):(.{2}):(.{2}).*$/,'D:$1$2$3$4$5$6Z'))
   const noteAppearance=targets.some(({operation})=>operation.action==='reply')?(await import('../../../../pdf/src/main/save-pdf.ts')).noteAppearance:null
   for(const {operation,ref,dict,pageIndex}of targets){
    if(operation.action==='edit'){
     dict.set(PDFName.of('Contents'),PDFHexString.fromText(operation.text))
     // AP is the sticky-note icon, not the comment text; retain its artwork.
     dict.delete(PDFName.of('RC'));dict.set(PDFName.of('M'),when)
    }else{
     const page=pages[pageIndex],rect=dict.lookup(PDFName.of('Rect')).asArray().map(value=>value.asNumber())
     const color=[1,0.9,0.3]
     const reply=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Text',Rect:rect,P:page.ref,Contents:PDFHexString.fromText(operation.text),T:PDFHexString.fromText('AI Assistant'),IRT:ref,RT:'R',Name:'Comment',F:4,C:color,CreationDate:when,M:when,AP:{N:doc.context.register(noteAppearance(doc,rect,color))}}))
     page.node.Annots().push(reply)
    }
   }
   const expected=pages.map(page=>(page.node.Annots()?.asArray()??[]).map(ref=>({ref:String(ref),dict:String(doc.context.lookup(ref))})))
   check(signal)
   const bytes=Buffer.from(await doc.save({updateFieldAppearances:false}));check(signal)
   if(bytes.length<1||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const reopened=await openEditablePdf(bytes);check(signal)
   if(reopened.getPageCount()!==pages.length)fail('PDF_ANNOTATION_VERIFY_FAILED')
   for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
    const actual=(reopened.getPage(pageIndex).node.Annots()?.asArray()??[]).map(ref=>({ref:String(ref),dict:String(reopened.context.lookup(ref))}))
    if(JSON.stringify(actual)!==JSON.stringify(expected[pageIndex]))fail('PDF_ANNOTATION_VERIFY_FAILED')
   }
   return {bytes,inputSha256,sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfNoteUpdateSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
