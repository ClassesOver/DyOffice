import {PDFArray,PDFDict,PDFName,PDFRef,PDFSignature} from 'pdf-lib'
import {pdfFormValueFields} from './form-values-job.mjs'
import {fail} from './job-common.mjs'

const n=PDFName.of
const invalid=()=>fail('INVALID_PDF_APPLY_SNAPSHOT')
const mismatch=()=>fail('PDF_APPLY_OPS_VERIFY_FAILED')
const coordinates=(dict,key)=>dict.lookup(n(key),PDFArray).asArray().map(value=>value.asNumber())
const near=(a,b)=>a.length===b.length&&a.every((value,index)=>Math.abs(value-b[index])<.1)

export function planPdfOutline(entries,count,deleted){
 if(entries===undefined)return
 return entries.flatMap(entry=>{
  if(entry.pageIndex>=count)invalid()
  const children=planPdfOutline(entry.children,count,deleted)
  return deleted.has(entry.pageIndex)?[]:[{...entry,...(children?{children}:{})}]
 })
}
export function verifyPdfOutline(doc,outline,order){
 if(outline===undefined)return
 const pages=doc.getPages(),indexForPage=new Map(order.map((source,index)=>[source,index]))
 const root=doc.catalog.lookup(n('Outlines'))
 if(!(root instanceof PDFDict))mismatch()
 function visit(parent,entries){
  let current=parent.lookup(n('First')),total=0
  for(const entry of entries){
   if(!(current instanceof PDFDict)||current.lookup(n('Title'))?.decodeText?.()!==entry.title.trim())mismatch()
   const dest=current.lookup(n('Dest'),PDFArray)
   if(dest.get(0)!==pages[indexForPage.get(entry.pageIndex)]?.ref||String(dest.get(1))!=='/XYZ')mismatch()
   if(entry.top==null?String(dest.get(3))!=='null':Math.abs((dest.get(3)?.asNumber?.()??Infinity)-entry.top)>.1)mismatch()
   total+=1+visit(current,entry.children??[])
   current=current.lookup(n('Next'))
  }
  if(current!==undefined||(parent.lookup(n('Count'))?.asNumber?.()??0)!==total)mismatch()
  return total
 }
 visit(root,outline)
}

const drawingSubtypes={ink:'/Ink',rect:'/Square',ellipse:'/Circle',line:'/Line',arrow:'/Line',measure:'/Line',caret:'/Caret',polygon:'/Polygon',image:'/Stamp',link:'/Link'}
export function verifyPdfDrawing(doc,dict,drawing,destination){
 if(!(dict instanceof PDFDict)||String(dict.get(n('Subtype')))!==drawingSubtypes[drawing.kind])mismatch()
 if(drawing.kind==='link'){
  if(!near(coordinates(dict,'Rect'),drawing.rect))mismatch()
  if(drawing.url){
   const action=dict.lookup(n('A'),PDFDict)
   if(String(action.get(n('S')))!=='/URI'||new TextDecoder().decode(action.lookup(n('URI')).asBytes())!==drawing.url)mismatch()
  }else if(dict.lookup(n('Dest'),PDFArray).get(0)!==doc.getPage(destination).ref)mismatch()
  return
 }
 if(!dict.lookupMaybe(n('AP'),PDFDict)?.has(n('N')))mismatch()
 if(drawing.color&&!near(coordinates(dict,'C'),drawing.color))mismatch()
 if(drawing.formFieldName&&dict.lookup(n('GenOfficeFormField'))?.decodeText?.()!==drawing.formFieldName)mismatch()
 switch(drawing.kind){
  case 'ink':{
   const paths=dict.lookup(n('InkList'),PDFArray)
   if(paths.size()!==drawing.paths.length||drawing.paths.some((path,index)=>!near(paths.lookup(index,PDFArray).asArray().map(value=>value.asNumber()),path)))mismatch()
   break
  }
  case 'image':
   if(!near(coordinates(dict,'Rect'),drawing.rect))mismatch()
   break
  case 'rect':case 'ellipse':{
   const pad=drawing.width+2
   if(!near(coordinates(dict,'Rect'),drawing.rect.map((value,index)=>value+(index<2?-pad:pad))))mismatch()
   break
  }
  case 'caret':{
   const [x,y]=drawing.point
   if(!near(coordinates(dict,'Rect'),[x-10,y-10,x+10,y+10]))mismatch()
   break
  }
  case 'line':case 'arrow':case 'measure':
   if(!near(coordinates(dict,'L'),[...drawing.from,...drawing.to]))mismatch()
   if(drawing.kind==='measure'&&dict.lookup(n('Contents'))?.decodeText?.()!==drawing.label)mismatch()
   break
  case 'polygon':
   if(!near(coordinates(dict,'Vertices'),drawing.vertices.flat()))mismatch()
   break
 }
}

function widgetRefs(field){
 const kids=field.acroField.Kids()
 return kids?.size()?kids.asArray():[field.ref]
}
const widgetId=ref=>ref.objectNumber+'R'+(ref.generationNumber||'')
export function planPdfWidgetEdits(edits,fields,widgetPages,deleted){
 return edits.map(edit=>{
  const field=fields.get(edit.fieldName)
  const index=field?widgetRefs(field).findIndex(ref=>ref instanceof PDFRef&&widgetId(ref)===edit.widgetId):-1
  const widget=field?.acroField.getWidgets()[index],page=widget?widgetPages.get(widget.dict):undefined
  if(!widget||page===undefined)invalid()
  return {edit,index,widget:widget.dict,deleted:deleted.has(page),refresh:!!edit.rect&&!edit.remove&&!(field instanceof PDFSignature)}
 })
}

// Text/image rewrites can renumber objects. The apply job verifies the complete form
// structure is unchanged first, so the corresponding widget index is authoritative.
export function resolvePdfWidgetEdits(doc,planned){
 if(!planned.length)return []
 const fields=pdfFormValueFields(doc)
 return planned.map(({edit,index})=>{
  const field=fields.get(edit.fieldName),ref=field&&widgetRefs(field)[index]
  if(!(ref instanceof PDFRef))mismatch()
  return {...edit,widgetId:widgetId(ref),ref}
 })
}
export function verifyPdfWidgetEdits(doc,planned,resolved){
 if(!planned.length)return
 const fields=doc.catalog.has(n('AcroForm'))?pdfFormValueFields(doc):new Map(),required=new Map()
 for(const [index,{edit,deleted,refresh}]of planned.entries()){
  const field=fields.get(edit.fieldName)
  const currentIndex=field?widgetRefs(field).findIndex(ref=>ref instanceof PDFRef&&widgetId(ref)===resolved[index].widgetId):-1
  if(!edit.remove&&edit.required!==undefined&&field)required.set(edit.fieldName,edit.required)
  if(edit.remove||deleted){
   if(currentIndex!==-1)mismatch()
   continue
  }
  if(currentIndex===-1)mismatch()
  const widget=field.acroField.getWidgets()[currentIndex]
  if(edit.rect&&!near(coordinates(widget.dict,'Rect'),edit.rect))mismatch()
  if(refresh&&!widget.dict.lookupMaybe(n('AP'),PDFDict)?.has(n('N')))mismatch()
 }
 for(const [name,value]of required)if(fields.get(name)?.isRequired()!==value)mismatch()
}
