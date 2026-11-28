import {PDFArray,PDFDict,PDFName,PDFRef,PDFStream} from 'pdf-lib'
import {createHash} from 'node:crypto'
import {openEditablePdf} from './editable-document.mjs'
import {assertPdfManagedStamps} from './stamps-job.mjs'
import {fail} from './job-common.mjs'
const name=PDFName.of
/** Protection checks for additive text and image operations. */
export async function openPdfForInserts(bytes,{planning=false}={}){
 const doc=await openEditablePdf(bytes,{allowAcroForm:true}),acro=doc.catalog.lookup(name('AcroForm'))
 if(acro!==undefined&&!(acro instanceof PDFDict)||acro?.has(name('XFA')))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 // Unlike field filling, insertion does not accept even an unsigned signature field.
 const pending=doc.context.enumerateIndirectObjects().map(([,value])=>value),seen=new Set()
 while(pending.length){
  const value=pending.pop();if(!value||seen.has(value))continue;seen.add(value)
  if(seen.size>100000)fail('PDF_EDIT_LIMIT')
  if(value instanceof PDFDict){if(String(value.lookup(name('FT')))==='/Sig')fail('SIGNATURE_EDIT_REFUSED');pending.push(...value.values())}
  else if(value instanceof PDFArray)pending.push(...value.asArray())
  else if(value instanceof PDFStream)pending.push(value.dict)
 }
 // Managed stamp reconstruction on forms is not yet verified; do not silently drop its guards.
 if(doc.getPages().some(page=>page.node.has(name('DyOfficeStamps')))){
  if(planning)assertPdfManagedStamps(doc)
  else if(acro)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 }
 return doc
}
/** Resolve object numbers, dictionary ordering and page backrefs before comparing form state. */
export function pdfInsertFormState(doc,{ignoreAttachedWidgetRects=false,pages=doc.getPages()}={}){
 const pageRefs=new Map(pages.flatMap((page,index)=>page?[[String(page.ref),index]]:[])),stack=new Set(),fieldPaths=new Map();let visited=0
 const widgets=pages.map(page=>(page?.node.Annots()?.asArray()??[]).map(ref=>doc.context.lookup(ref)).filter(dict=>dict instanceof PDFDict&&String(dict.lookup(name('Subtype')))==='/Widget'))
 const omitRects=ignoreAttachedWidgetRects?new Set(widgets.flat()):undefined
 const acro=doc.catalog.lookup(name('AcroForm'))
 function mapField(raw,path,depth=0){
  const field=doc.context.lookup(raw)
  if(depth>64||fieldPaths.size>10000)fail('PDF_EDIT_LIMIT')
  if(!(field instanceof PDFDict)||fieldPaths.has(field))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  fieldPaths.set(field,path)
  const kids=field.lookup(name('Kids'))
  if(kids!==undefined){if(!(kids instanceof PDFArray))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE');kids.asArray().forEach((kid,index)=>mapField(kid,`${path}/Kids/${index}`,depth+1))}
 }
 const roots=acro?.lookup(name('Fields'))
 if(roots!==undefined){if(!(roots instanceof PDFArray))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE');roots.asArray().forEach((field,index)=>mapField(field,`Fields/${index}`))}
 function encode(raw,field=false,depth=0){
  if(depth>64||++visited>100000)fail('PDF_EDIT_LIMIT')
  const value=raw instanceof PDFRef?doc.context.lookup(raw):raw
  if(value===undefined)return null
  if(stack.has(value))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  if(value instanceof PDFDict||value instanceof PDFArray||value instanceof PDFStream){
   stack.add(value)
   try{
    if(value instanceof PDFArray)return value.asArray().map(item=>encode(item,field,depth+1))
    if(value instanceof PDFStream)return {dict:encode(value.dict,false,depth+1),data:createHash('sha256').update(value.getContents()).digest('hex')}
    const widget=String(value.lookup(name('Subtype')))==='/Widget',entries=[]
    for(const [key,item]of value.entries().sort(([a],[b])=>a.decodeText().localeCompare(b.decodeText()))){
     const k=key.decodeText()
     if(k==='Rect'&&omitRects?.has(value))continue
     if(k==='CO'&&value===acro){
      const order=doc.context.lookup(item)
      if(!(order instanceof PDFArray))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
      entries.push([k,order.asArray().map(ref=>{
       const field=fieldPaths.get(doc.context.lookup(ref))
       if(field===undefined)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
       return {field}
      })]);continue
     }
     if((field||widget)&&k==='Parent'){
      const parent=fieldPaths.get(doc.context.lookup(item));if(parent===undefined)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
      entries.push([k,{field:parent}]);continue
     }
     if(widget&&k==='P'){
      const index=pageRefs.get(String(item));if(index===undefined)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE');entries.push([k,index]);continue
     }
     entries.push([k,encode(item,k==='Fields'||(field&&k==='Kids'),depth+1)])
    }
    return entries
   }finally{stack.delete(value)}
  }
  if(typeof value.asBytes==='function')return {bytes:Buffer.from(value.asBytes()).toString('hex')}
  return String(value)
 }
 return JSON.stringify({acro:encode(acro),widgets:widgets.map(page=>page.map(dict=>encode(dict,true)))})
}
export function assertPdfInsertFormPreserved(before,after){if(pdfInsertFormState(before)!==pdfInsertFormState(after))fail('PDF_FORM_INSERT_INTEGRITY_FAILED')}
