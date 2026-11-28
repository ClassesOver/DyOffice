import {PDFDocument,PDFName,PDFDict,PDFNumber,PDFRef,PDFHexString,PDFString} from 'pdf-lib'
import {openPdfForPendingEdits as open} from './pending-document.mjs'
import {pdfInsertFormState,assertPdfInsertFormPreserved} from './insert-form-integrity.mjs'
import {updatePdfFormFieldAppearances,pdfFormFieldsSafetyCodes} from './form-fields-job.mjs'
import {createPdfAppearanceFontSelector,preparePdfFormValues,pdfFormValueFields,updatePdfFormValueAppearances,pdfFormValuesSafetyCodes} from './form-values-job.mjs'
import {cleanupDeletedPageForms} from './deleted-page-forms.mjs'
import {validatePdfApplySnapshot} from './apply-snapshot.mjs'
import {MAX_PDF_EDIT_PAGES} from '../../../shared/pdf-edit-structure.mjs'
import {staticFormFillsFromCatalog} from '../../../../pdf/src/shared/static-form-fills.ts'
import {decodePdfImage} from './image-content-job.mjs'
import {applyExistingImages,pdfDraftInsertsSafetyCodes} from './draft-inserts-job.mjs'
import {capturePdfManagedStamps,reapplyPdfManagedStamps,preservePdfManagedStamps,pdfStampsSafetyCodes} from './stamps-job.mjs'
import {planPdfOutline,verifyPdfOutline,verifyPdfDrawing,planPdfWidgetEdits,resolvePdfWidgetEdits,verifyPdfWidgetEdits} from './apply-document-details.mjs'
import {isolatePdfImageResources} from './isolate-image-resources.mjs'
import {fail,hash,requireEnvelope} from './job-common.mjs'
export {validatePdfApplySnapshot}
const n=PDFName.of,MAX=64*1024*1024
const check=signal=>{if(signal?.aborted)fail('ABORTED')}
export const pdfApplyOpsSafetyCodes=new Set([...pdfFormFieldsSafetyCodes,...pdfFormValuesSafetyCodes,...pdfStampsSafetyCodes,...pdfDraftInsertsSafetyCodes,'INVALID_PDF_APPLY_SNAPSHOT','PDF_APPLY_OPS_VERIFY_FAILED','PDF_APPLY_OPS_REFUSED'])
export function parsePdfApplyOpsRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST');if(Buffer.byteLength(raw)>32*1024*1024)fail('REQUEST_LIMIT')
 let r;try{r=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 requireEnvelope(r,'applyOps','snapshot')
 return validatePdfApplySnapshot(r.snapshot)
}

function visible(doc,index,coordinates,point=false){
 if(!Number.isSafeInteger(index)||index<0||index>=doc.getPageCount())fail('INVALID_PDF_APPLY_SNAPSHOT')
 const p=doc.getPage(index),a=p.getCropBox(),b=p.getMediaBox(),x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),top=Math.min(a.y+a.height,b.y+b.height)
 if(![x,y,right,top].every(Number.isFinite)||right<=x||top<=y)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 for(let i=0;i<coordinates.length;i+=2)if(coordinates[i]<x-.01||coordinates[i]>right+.01||coordinates[i+1]<y-.01||coordinates[i+1]>top+.01)fail('INVALID_PDF_APPLY_SNAPSHOT')
 if(!point&&coordinates.length===4&&(coordinates[2]-coordinates[0]<1||coordinates[3]-coordinates[1]<1))fail('INVALID_PDF_APPLY_SNAPSHOT')
}
const savedSubtype={highlight:'/Highlight',underline:'/Underline',squiggly:'/Squiggly',strikeout:'/StrikeOut',polygon:'/Polygon',note:'/Text'}
function matchSavedAnnotation(entries,operation,subtype,contents){
 const matches=entries.filter(e=>e.ref instanceof PDFRef&&e.ref.objectNumber===operation.objNum)
 const entry=matches[0]
 if(matches.length!==1||entry.page!==operation.pageIndex||!(entry.dict instanceof PDFDict)||String(entry.dict.get(n('Subtype')))!==subtype)fail('INVALID_PDF_APPLY_SNAPSHOT')
 const rect=entry.dict.lookup(n('Rect'))?.asArray?.().map(value=>value.asNumber?.())
 const actual=rect?.length===4&&rect.every(Number.isFinite)?[Math.min(rect[0],rect[2]),Math.min(rect[1],rect[3]),Math.max(rect[0],rect[2]),Math.max(rect[1],rect[3])]:null
 const axes=subtype==='/Text'?[0,3]:[0,1,2,3]
 if(!actual||axes.some(axis=>Math.abs(actual[axis]-operation.rect[axis])>2)||contents!==undefined&&(entry.dict.lookup(n('Contents'))?.decodeText?.()??'')!==contents)fail('INVALID_PDF_APPLY_SNAPSHOT')
 return entry
}
function savedAnnotationEntries(doc){
 return doc.getPages().flatMap((page,index)=>(page.node.Annots()?.asArray()??[]).map((ref,offset)=>({page:index,array:page.node.Annots(),offset,ref,dict:doc.context.lookup(ref)})))
}
async function updateSavedAnnotations(doc,s){
 const entries=savedAnnotationEntries(doc)
 if(entries.length>10000)fail('INVALID_PDF_APPLY_SNAPSHOT')
 const removed=new Set(),edits=new Map()
 for(const operation of s.annotDeletes??[])removed.add(String(matchSavedAnnotation(entries,operation,savedSubtype[operation.subtype],operation.contents).ref))
 for(const operation of s.noteEdits??[])edits.set(String(matchSavedAnnotation(entries,operation,'/Text',operation.oldContents).ref),operation)
 for(const entry of entries){
  if(!(entry.dict instanceof PDFDict))continue
  const subtype=String(entry.dict.get(n('Subtype')))
  if(subtype==='/Popup'&&removed.has(String(entry.dict.get(n('Parent')))))removed.add(String(entry.ref))
  if(!removed.has(String(entry.ref))&&removed.has(String(entry.dict.get(n('IRT')))))fail('INVALID_PDF_APPLY_SNAPSHOT')
 }
 for(const {input:note} of s.notes){
  if(!note.replyToSaved)continue
  const target=matchSavedAnnotation(entries,{...note.replyToSaved,pageIndex:note.pageIndex},'/Text',note.replyToSaved.contents)
  if(removed.has(String(target.ref))||target.dict.has(n('IRT')))fail('INVALID_PDF_APPLY_SNAPSHOT')
  const edit=edits.get(String(target.ref))
  if(edit)note.replyToSaved.contents=edit.contents
 }
 for(const entry of entries.toReversed()){
  const id=String(entry.ref)
  if(removed.has(id))entry.array.remove(entry.offset)
  const edit=edits.get(id)
  if(edit){
   entry.dict.set(n('Contents'),PDFHexString.fromText(edit.contents))
   entry.dict.delete(n('RC'))
   entry.dict.set(n('M'),PDFString.fromDate(new Date()))
  }
 }
 return Buffer.from(await doc.save({updateFieldAppearances:false}))
}
function plan(doc,s){
 const count=doc.getPageCount(),deleted=new Set(s.deleted),all=Array.from({length:count},(_,i)=>i)
 if(s.deleted.some(p=>p>=count)||deleted.size>=count||Object.keys(s.rotations).some(p=>Number(p)>=count)||s.order!==null&&(s.order.length!==count||all.some(p=>!s.order.includes(p))))fail('INVALID_PDF_APPLY_SNAPSHOT')
 const order=(s.order??all).filter(p=>!deleted.has(p)),existing=doc.catalog.has(n('AcroForm'))?pdfFormValueFields(doc):new Map(),radio=new Map([...existing].filter(([,f])=>f.constructor.name==='PDFRadioGroup').map(([name,f])=>[name,[...f.getOptions()]])),names=new Map([...existing].map(([name,f])=>[name,f.constructor.name]))
 const fields=s.formFields.map(({input:f})=>{
  visible(doc,f.pageIndex,f.rect);if(existing.get(f.name)?.isReadOnly())fail('INVALID_PDF_APPLY_SNAPSHOT');if(deleted.has(f.pageIndex))fail('INVALID_PDF_APPLY_SNAPSHOT')
  if(names.has(f.name)&&!(f.kind==='radio'&&names.get(f.name)==='PDFRadioGroup')||[...names.keys()].some(name=>name!==f.name&&(name.startsWith(f.name+'.')||f.name.startsWith(name+'.'))))fail('PDF_FORM_FIELD_CONFLICT')
  names.set(f.name,{radio:'PDFRadioGroup',text:'PDFTextField',checkbox:'PDFCheckBox',choice:'PDFDropdown',signature:'PDFSignature'}[f.kind])
  if(f.kind==='radio'){const options=radio.get(f.name)??[],value=f.exportValue??`option_${options.length+1}`;if(options.includes(value))fail('PDF_FORM_FIELD_CONFLICT');radio.set(f.name,[...options,value]);return {...f,exportValue:value}}
  return {...f,...(f.kind==='choice'?{options:f.options??[]}:{})}
 })
 const values=Object.values(s.formEdits),operations=values.map(v=>{const {kind,...value}=v;return {op:'setFormValue',value}}),prepared=operations.length?preparePdfFormValues(doc,operations):[]
 if(prepared.some((value,i)=>value.kind!==values[i].kind))fail('INVALID_PDF_APPLY_SNAPSHOT')
 const clearedValues=new Set(),pageIndices=new Map(doc.getPages().map((page,index)=>[String(page.ref),index])),widgetPages=new Map(doc.getPages().flatMap((page,index)=>(page.node.Annots()?.asArray()??[]).map(ref=>[doc.context.lookup(ref),index])))
 const widgetEdits=planPdfWidgetEdits(s.formWidgetEdits??[],existing,widgetPages,deleted)
 const removedWidgets=new Set(widgetEdits.filter(target=>target.edit.remove).map(target=>target.widget))
 for(const value of prepared){
  if(value.kind!=='radio'&&value.kind!=='checkbox')continue
  const field=existing.get(value.name),widgets=field.acroField.getWidgets(),selected=value.kind==='radio'?widgets[field.getOptions().lastIndexOf(value.value)]?.getOnValue():value.checked?widgets[0]?.getOnValue():undefined
  if(selected&&!widgets.some(widget=>widget.getOnValue()===selected&&!removedWidgets.has(widget.dict)&&!deleted.has(pageIndices.get(String(widget.dict.get(n('P'))))??widgetPages.get(widget.dict))))clearedValues.add(value.name)
 }

 for(const m of s.markups){if(deleted.has(m.pageIndex))fail('INVALID_PDF_APPLY_SNAPSHOT');m.quads.forEach(q=>visible(doc,m.pageIndex,q,true))}
 const local=new Map()
 for(const {id,input:o}of s.notes){
  visible(doc,o.pageIndex,o.at,true);if(deleted.has(o.pageIndex))fail('INVALID_PDF_APPLY_SNAPSHOT')
  const localId=o.localId??id;if(local.has(localId))fail('INVALID_PDF_APPLY_SNAPSHOT')
  if(o.replyToLocalId&&(!local.has(o.replyToLocalId)||local.get(o.replyToLocalId)!==o.pageIndex))fail('INVALID_PDF_APPLY_SNAPSHOT')
  if(o.replyToSaved&&matchSavedAnnotation(savedAnnotationEntries(doc),{...o.replyToSaved,pageIndex:o.pageIndex},'/Text',o.replyToSaved.contents).dict.has(n('IRT')))fail('INVALID_PDF_APPLY_SNAPSHOT')
  local.set(localId,o.pageIndex)
 }
 for(const {input:o}of s.textInserts)visible(doc,o.pageIndex,o.origin,true)
 for(const {input:o}of s.imageEdits){if(o.rect)visible(doc,o.pageIndex,o.rect,true);if(o.oldRect)visible(doc,o.pageIndex,o.oldRect,true)}
 const drawings=s.drawings??[]
 for(const drawing of drawings){
  if(drawing.pageIndex>=count||deleted.has(drawing.pageIndex))fail('INVALID_PDF_APPLY_SNAPSHOT')
  if(drawing.kind==='link'&&drawing.destPage!==undefined&&(drawing.destPage>count||deleted.has(drawing.destPage-1)))fail('INVALID_PDF_APPLY_SNAPSHOT')
  if(drawing.formFieldName){
   const field=existing.get(drawing.formFieldName),fieldAdded=fields.some(f=>f.name===drawing.formFieldName&&f.kind==='signature'&&f.pageIndex===drawing.pageIndex)
   if(!fieldAdded&&(field?.constructor.name!=='PDFSignature'||!field.acroField.getWidgets().some(widget=>widgetPages.get(widget.dict)===drawing.pageIndex)))fail('INVALID_PDF_APPLY_SNAPSHOT')
  }
 }
 const outline=planPdfOutline(s.outline,count,deleted)
 return {fields,values:prepared,clearedValues,order,drawings,outline,widgetEdits,notes:s.notes.map(({id,input:o})=>({...o,localId:o.localId??id}))}
}
const near=(a,b)=>a.length===b.length&&a.every((x,i)=>Math.abs(x-b[i])<.1)
const sameLeaf=(a,b)=>JSON.stringify([a.type,a.text,a.font,a.image,a.fill,a.stroke,a.size,a.mode])===JSON.stringify([b.type,b.text,b.font,b.image,b.fill,b.stroke,b.size,b.mode])&&near(a.bounds,b.bounds)&&near(a.matrix,b.matrix)
function normalizedForm(doc){
 // Stream Length is derived during serialization, not an editable form property.
 const strip=value=>Array.isArray(value)?value.filter(item=>!(Array.isArray(item)&&item[0]==='Length')).map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,strip(v)])):value
 return JSON.stringify(strip(JSON.parse(pdfInsertFormState(doc))))
}
function verifyOriginalContent(before,after,s,order){
 for(let output=0;output<order.length;output++){
  const page=order[output],old=before.filter(x=>x.page===page),current=after.filter(x=>x.page===output),claimed=new Set()
  for(const edit of s.imageEdits.map(e=>e.input).filter(e=>e.pageIndex===page&&e.kind!=='insertImage')){const matches=old.map((item,index)=>({item,index})).filter(({item})=>item.type===3&&near(item.bounds,edit.oldRect));if(matches.length!==1||claimed.has(matches[0].index))fail('PDF_APPLY_OPS_VERIFY_FAILED');claimed.add(matches[0].index)}
  let cursor=0
  for(let i=0;i<old.length;i++){if(claimed.has(i))continue;let found=-1;for(let k=cursor;k<current.length;k++)if(sameLeaf(old[i],current[k])){found=k;break}if(found<0)fail('PDF_APPLY_OPS_VERIFY_FAILED');cursor=found+1}
 }
}
function verifyAnnotations(doc,s,planned,original){
 const types={highlight:'/Highlight',underline:'/Underline',squiggly:'/Squiggly',strikeout:'/StrikeOut'},used=new Set(),locals=new Map()
 for(let output=0;output<planned.order.length;output++){
  const source=planned.order[output],entries=(doc.getPage(output).node.Annots()?.asArray()??[]).map(ref=>({ref:String(ref),dict:doc.context.lookup(ref)}))
  for(const old of original[source]){const found=entries.find(e=>e.ref===old.ref);if(!found||String(found.dict)!==old.value)fail('PDF_APPLY_OPS_VERIFY_FAILED');used.add(found.ref)}
  for(const markup of s.markups.filter(m=>m.pageIndex===source)){
   const found=entries.find(e=>!used.has(e.ref)&&String(e.dict.get(n('Subtype')))===types[markup.type]&&near(e.dict.lookup(n('QuadPoints'))?.asArray?.().map(v=>v.asNumber())??[],markup.quads.flat()))
   if(!found)fail('PDF_APPLY_OPS_VERIFY_FAILED');used.add(found.ref)
  }
  for(const note of planned.notes.filter(note=>note.pageIndex===source)){
   const parent=note.replyToLocalId?locals.get(note.replyToLocalId):undefined
   const found=entries.find(e=>!used.has(e.ref)&&String(e.dict.get(n('Subtype')))==='/Text'&&e.dict.lookup(n('Contents'))?.decodeText?.()===note.contents&&e.dict.lookup(n('T'))?.decodeText?.()===(note.author||'AI Assistant')&&(!note.replyToLocalId||String(e.dict.get(n('IRT')))===parent))
   if(!found)fail('PDF_APPLY_OPS_VERIFY_FAILED');used.add(found.ref);locals.set(note.localId,found.ref)
  }
  const remaining=entries.filter(e=>String(e.dict.get(n('Subtype')))!=='/Widget'&&!used.has(e.ref))
  const drawings=planned.drawings.filter(drawing=>drawing.pageIndex===source)
  if(remaining.length!==drawings.length)fail('PDF_APPLY_OPS_VERIFY_FAILED')
  for(const [index,drawing]of drawings.entries())verifyPdfDrawing(doc,remaining[index].dict,drawing,planned.order.indexOf(drawing.destPage-1))
 }
}
function verifyFormTargets(doc,planned,s,surviving){
 const fields=doc.catalog.has(n('AcroForm'))?pdfFormValueFields(doc):new Map(),pageMap=new Map(planned.order.map((page,index)=>[page,index])),types={text:'PDFTextField',checkbox:'PDFCheckBox',radio:'PDFRadioGroup',choice:'PDFDropdown',signature:'PDFSignature'}
 for(const value of planned.values){
  if(!surviving.has(value.name))continue
  const field=fields.get(value.name);if(!field||field.constructor.name!==types[value.kind])fail('PDF_APPLY_OPS_VERIFY_FAILED')
  const selectedNew=planned.fields.find(f=>f.name===value.name&&f.kind==='radio'&&f.checked)
  const actual=value.kind==='text'?field.getText()??'':value.kind==='checkbox'?field.isChecked():value.kind==='radio'?field.getSelected()??'':field.getSelected(),expected=selectedNew?.exportValue??(value.kind==='checkbox'?value.checked&&!planned.clearedValues.has(value.name):value.kind==='radio'&&planned.clearedValues.has(value.name)?'':value.kind==='choice'?(value.value?[value.value]:[]):value.value)
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('PDF_APPLY_OPS_VERIFY_FAILED')
  for(const widget of field.acroField.getWidgets())if(!widget.dict.lookupMaybe(n('AP'),PDFDict)?.has(n('N')))fail('PDF_APPLY_OPS_VERIFY_FAILED')
 }
 for(const name of new Set(planned.fields.map(f=>f.name))){
  const added=planned.fields.filter(f=>f.name===name),f=added[0],field=fields.get(name)
  if(!field||field.constructor.name!==types[f.kind]||added.some(f=>f.required)&&!field.isRequired())fail('PDF_APPLY_OPS_VERIFY_FAILED')
  const all=field.acroField.getWidgets(),widgets=all.slice(-added.length);if(widgets.length!==added.length)fail('PDF_APPLY_OPS_VERIFY_FAILED')
  if(f.kind==='text'&&((field.getText()??'')!==(f.value??'')||field.isMultiline()!==!!f.multiLine||(field.getMaxLength()??0)!==(f.maxLen??0)||field.getAlignment()!==({left:0,center:1,right:2}[f.textAlignment??'left'])))fail('PDF_APPLY_OPS_VERIFY_FAILED')
  if(f.kind==='text'){
   if(f.fontSize){const size=field.acroField.getDefaultAppearance()?.match(/([0-9.]+)\s+Tf/);if(!size||Math.abs(Number(size[1])-f.fontSize)>0.02)fail('PDF_APPLY_OPS_VERIFY_FAILED')}
   if(f.dateFormat)for(const dict of [field.acroField.dict,...widgets.map(w=>w.dict)]){
    const actions=dict.lookupMaybe(n('AA'),PDFDict)
    for(const [key,script]of [['F',`AFDate_FormatEx("${f.dateFormat}");`],['K',`AFDate_KeystrokeEx("${f.dateFormat}");`]]){const action=actions?.lookupMaybe(n(key),PDFDict);if(String(action?.get(n('S')))!=='/JavaScript'||action?.lookup(n('JS'))?.decodeText?.()!==script)fail('PDF_APPLY_OPS_VERIFY_FAILED')}
   }
  }
  if(f.kind==='checkbox'&&field.isChecked()!==!!f.checked)fail('PDF_APPLY_OPS_VERIFY_FAILED')
  if(f.kind==='choice'&&(JSON.stringify(field.getOptions())!==JSON.stringify(f.options??[])||JSON.stringify(field.getSelected())!==JSON.stringify(f.value?[f.value]:[])))fail('PDF_APPLY_OPS_VERIFY_FAILED')
  if(f.kind==='radio'){
   if(added.some(f=>!field.getOptions().includes(f.exportValue)))fail('PDF_APPLY_OPS_VERIFY_FAILED')
   const checked=added.find(f=>f.checked);if(checked&&field.getSelected()!==checked.exportValue)fail('PDF_APPLY_OPS_VERIFY_FAILED')
  }
  for(let i=0;i<widgets.length;i++){
   const widget=widgets[i],r=widget.getRectangle(),expected=added[i],page=doc.getPage(pageMap.get(expected.pageIndex))
   if(!near([r.x,r.y,r.x+r.width,r.y+r.height],expected.rect)||String(widget.dict.get(n('P')))!==String(page.ref))fail('PDF_APPLY_OPS_VERIFY_FAILED')
   if(f.kind==='signature'){if(field.acroField.dict.has(n('V')))fail('PDF_APPLY_OPS_VERIFY_FAILED')}
   else if(!widget.dict.lookupMaybe(n('AP'),PDFDict)?.has(n('N')))fail('PDF_APPLY_OPS_VERIFY_FAILED')
  }
 }
}
async function verifyImages(bytes,before,after,s,order,signal){
 const {imageMatrix,readImageBitmap}=await import('../../../../pdf/src/main/image-edit.ts'),{createPdfImagePixelSource}=await import('./isolate-image-resources.mjs')
 for(let output=0;output<order.length;output++){
  const page=order[output],edits=s.imageEdits.map(e=>e.input).filter(e=>e.pageIndex===page),old=before.filter(e=>e.page===page&&e.type===3),current=after.filter(e=>e.page===output&&e.type===3),expected=old.length+edits.filter(e=>e.kind==='insertImage').length-edits.filter(e=>e.kind==='deleteImage').length
  if(current.length!==expected)fail('PDF_APPLY_OPS_VERIFY_FAILED')
  const used=new Set()
  for(const edit of edits.filter(e=>e.kind!=='deleteImage')){
   const found=current.map((item,index)=>({item,index})).filter(({item,index})=>!used.has(index)&&near(item.bounds,edit.rect))
   if(found.length!==1)fail('PDF_APPLY_OPS_VERIFY_FAILED');const candidate=found[0];used.add(candidate.index)
   if(edit.kind==='insertImage'&&!near(candidate.item.matrix,imageMatrix(edit.rect,edit.rotate)))fail('PDF_APPLY_OPS_VERIFY_FAILED')
   if(edit.kind==='transformImage'){
    const source=old.find(item=>near(item.bounds,edit.oldRect))
    if(!source||source.image!==candidate.item.image)fail('PDF_APPLY_OPS_VERIFY_FAILED')
   }
   if(edit.image){
    const decoded=decodePdfImage({mime:Buffer.from(edit.image,'base64')[0]===255?'image/jpeg':'image/png',base64:edit.image}),bare=await createPdfImagePixelSource(bytes,output,candidate.index),actual=await readImageBitmap(bare.bytes,0,[0,0,bare.width,bare.height],decoded.width,decoded.height)
    if(actual.length!==decoded.bgra.length)fail('PDF_APPLY_OPS_VERIFY_FAILED')
    for(let i=0;i<actual.length;i+=4)if(actual[i+3]!==decoded.bgra[i+3]||actual[i+3]&&[0,1,2].some(k=>actual[i+k]!==decoded.bgra[i+k]))fail('PDF_APPLY_OPS_VERIFY_FAILED')
   }
   check(signal)
  }
 }
}
export function createPdfApplyOpsJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||!input.length||input.length>MAX)fail('INPUT_LIMIT')
  const s=parsePdfApplyOpsRequest(raw),original=Buffer.from(input);busy=true
  try{
   const before=await open(original),originalCount=before.getPageCount(),blanks=s.blankPages??[]
   if(originalCount+blanks.length>MAX_PDF_EDIT_PAGES||blanks.some((page,index)=>page.pageIndex!==originalCount+index))fail('INVALID_PDF_APPLY_SNAPSHOT')
   const staticFormFills=s.staticFormFills??staticFormFillsFromCatalog(before)
   if(s.staticFormFills?.some(fill=>fill.pageIndex>=originalCount+blanks.length))fail('INVALID_PDF_APPLY_SNAPSHOT')
   const {applySaveRequest,applyFormFields}=await import('../../../../pdf/src/main/save-pdf.ts'),{readPdfLeafObjects,readUneditedPdfLeaves,applyTextEdits,verifyTextBlockMoves,verifyTextEdits,validateTextEdits}=await import('../../../../pdf/src/main/text-edit.ts')
   const savedImages=s.savedImageEdits??[]
   if(savedImages.some(op=>op.page>before.getPageCount()))fail('INVALID_PDF_APPLY_SNAPSHOT')
   const prepared=s.annotDeletes?.length||s.noteEdits?.length?await updateSavedAnnotations(before,s):original
   const directTargets=s.imageEdits.map(({input})=>input).filter(input=>input.kind!=='insertImage'&&savedImages.some(op=>op.page===input.pageIndex+1))
   const edited=await applyExistingImages(prepared,savedImages.filter(op=>!s.deleted.includes(op.page-1)),signal,directTargets)
   if(directTargets.length){
    const old=await readPdfLeafObjects(prepared,true),updated=await readPdfLeafObjects(edited,true)
    for(const target of directTargets){
     const find=items=>items.filter(item=>item.type===3&&item.page===target.pageIndex&&item.bounds.every((value,index)=>Math.abs(value-target.oldRect[index])<=2))
     const before=find(old),after=find(updated)
     if(before.length!==1||after.length!==1||!sameLeaf(before[0],after[0]))fail('PDF_IMAGE_TARGET_AMBIGUOUS')
    }
   }
   const stamped=before.getPage(0).node.has(n('DyOfficeStamps')),topologyChanged=blanks.length>0||s.deleted.length>0||s.order?.some((page,index)=>page!==index)
   // Regenerate numbering against the final page order. Otherwise keep stamp paint order intact.
   const replacingImage=s.imageEdits.some(({input})=>input.kind==='replaceImage')
   const captured=stamped&&(topologyChanged||replacingImage)?await capturePdfManagedStamps(edited,{allowAcroForm:true}):null
   let working=captured?.bytes??edited
   const textEdits=s.textEdits??[]
   if(textEdits.length){
    for(const edit of textEdits){
     if(s.deleted.includes(edit.pageIndex))fail('INVALID_PDF_APPLY_SNAPSHOT')
     visible(before,edit.pageIndex,edit.rect)
     if(edit.origin)visible(before,edit.pageIndex,edit.origin,true)
    }
    const untouched=await readUneditedPdfLeaves(working,textEdits)
    if(!untouched)fail('PDF_APPLY_OPS_REFUSED')
    const applied=await applyTextEdits(working,textEdits)
    if(applied.skipped.length)fail('PDF_APPLY_OPS_REFUSED')
    const deletions=textEdits.filter(edit=>!edit.newText.trim())
    if((await verifyTextEdits(applied.bytes,textEdits)).length||deletions.length&&(await validateTextEdits(applied.bytes,deletions)).some(edit=>edit.reason===null))fail('PDF_APPLY_OPS_VERIFY_FAILED')
    if(textEdits.every(edit=>edit.translate)&&!await verifyTextBlockMoves(working,applied.bytes,textEdits))fail('PDF_APPLY_OPS_VERIFY_FAILED')
    const afterRewrite=await readPdfLeafObjects(applied.bytes,true,{normalizeSyntheticTextSuffix:true})
    verifyOriginalContent(untouched,afterRewrite,{imageEdits:[]},Array.from({length:originalCount},(_,i)=>i))
    working=Buffer.from(applied.bytes)
   }
   const leaves=await readPdfLeafObjects(working,true,{normalizeSyntheticTextSuffix:true});check(signal)
   // PDFium may replace the resource shared by several draws of the same image.
   if(replacingImage){working=await isolatePdfImageResources(working);check(signal)}
   for(const blank of blanks)before.addPage([blank.width,blank.height])
   const planned=plan(before,s)
   let expectedForm,currentPageRefs,originalAnnots,survivingFields,resolvedWidgetEdits;const widgetEdits=[]
   const request={blankPages:blanks,markups:s.markups.map(({id,...m})=>m),drawings:[...planned.notes,...planned.drawings],outline:planned.outline,formWidgetEdits:widgetEdits,formValues:[],formFields:[],textInserts:s.textInserts.map(e=>e.input),imageEdits:s.imageEdits.map(e=>e.input),rotations:Object.entries(s.rotations).map(([p,delta])=>({pageIndex:Number(p),delta})),deletedPages:s.deleted,pageOrder:planned.order,metadata:s.metadata,annotationAuthor:s.annotationAuthor??'AI Assistant',...(s.attachments?{attachments:s.attachments}:{})}
   if(s.staticFormFills||staticFormFills.length)request.staticFormFills=staticFormFills
   let selectMeasureFont
   const result=await applySaveRequest(working,request,{
    measureFont:async(doc,label)=>{
     selectMeasureFont??=createPdfAppearanceFontSelector(doc)
     try{return await selectMeasureFont(label)}catch(error){
      if(error?.code!=='PDF_FORM_FONT_UNAVAILABLE')throw error
     }
    },
    decodeImage:base64=>decodePdfImage({mime:Buffer.from(base64,'base64')[0]===255?'image/jpeg':'image/png',base64}),
    applyFormValues:doc=>{
     assertPdfInsertFormPreserved(before,doc)
     resolvedWidgetEdits=resolvePdfWidgetEdits(doc,planned.widgetEdits)
     widgetEdits.push(...resolvedWidgetEdits.filter(edit=>!edit.remove).map(({ref,...edit})=>edit))
     currentPageRefs=doc.getPages().map(p=>String(p.ref))
     originalAnnots=doc.getPages().map(page=>(page.node.Annots()?.asArray()??[]).map(ref=>({ref:String(ref),dict:doc.context.lookup(ref)})).filter(e=>String(e.dict?.get?.(n('Subtype')))!=='/Widget').map(e=>({ref:e.ref,value:String(e.dict)})))
     for(const value of planned.values){const field=doc.getForm().getField(value.name);if(value.kind==='text')field.setText(value.value);else if(value.kind==='checkbox')value.checked?field.check():field.uncheck();else value.value?field.select(value.value):field.clear()}
    },
    applyFormFields:doc=>{
     const defaults=new Map((doc.catalog.has(n('AcroForm'))?doc.getForm().getFields():[]).filter(f=>f.constructor.name==='PDFRadioGroup'&&planned.fields.some(op=>op.name===f.getName())).map(f=>[f.getName(),f.acroField.dict.get(n('DA'))]))
     if(planned.fields.length)applyFormFields(doc,planned.fields.map(f=>f.kind==='choice'?{...f,options:[],value:undefined}:f))
     for(const [name,da]of defaults){const d=doc.getForm().getRadioGroup(name).acroField.dict;if(da===undefined)d.delete(n('DA'));else d.set(n('DA'),da)}
     cleanupDeletedPageForms(doc,s.deleted.map(index=>String(doc.getPage(index).ref)),resolvedWidgetEdits.filter(edit=>edit.remove).map(edit=>String(edit.ref)))
     survivingFields=new Set(doc.catalog.has(n('AcroForm'))?pdfFormValueFields(doc).keys():[])
    },
    updateFieldAppearances:async doc=>{
     const existing=doc.catalog.has(n('AcroForm'))?pdfFormValueFields(doc):new Map(),surviving=planned.values.filter(v=>existing.has(v.name))
     const refreshNames=new Set(surviving.map(v=>v.name))
     for(const {edit,refresh,deleted} of planned.widgetEdits)if(refresh&&!deleted&&existing.has(edit.fieldName))refreshNames.add(edit.fieldName)
     if(refreshNames.size)await updatePdfFormValueAppearances(doc,[...refreshNames],signal)
     if(planned.fields.length)await updatePdfFormFieldAppearances(doc,planned.fields.filter(f=>existing.has(f.name)),signal)
     await doc.flush();expectedForm=normalizedForm(doc);check(signal)
    },
   });check(signal)
   if(result.skippedTextEdits.length||result.skippedTextInserts.length||result.skippedImageEdits.length)fail('PDF_APPLY_OPS_REFUSED')
   let bytes=stamped&&!captured?await preservePdfManagedStamps(edited,result.bytes,{allowAcroForm:true,pending:true}):Buffer.from(result.bytes)
   if(!bytes.length||bytes.length>MAX)fail('OUTPUT_LIMIT');const after=await open(bytes)
   if(after.getPageCount()!==planned.order.length||normalizedForm(after)!==expectedForm)fail('PDF_APPLY_OPS_VERIFY_FAILED')
   for(let i=0;i<planned.order.length;i++){const page=planned.order[i],old=before.getPage(page),actual=after.getPage(i);if(currentPageRefs[page]!==String(actual.ref)||((actual.getRotation().angle%360)+360)%360!==((old.getRotation().angle+(s.rotations[page]??0))%360+360)%360||page>=originalCount&&(actual.getWidth()!==old.getWidth()||actual.getHeight()!==old.getHeight()))fail('PDF_APPLY_OPS_VERIFY_FAILED')}
   for(const [key,value]of Object.entries(s.metadata??{})){const actual=after[{title:'getTitle',author:'getAuthor',subject:'getSubject',keywords:'getKeywords'}[key]]()??'',expected=key==='keywords'?value.split(/[,，;；]/).map(v=>v.trim()).filter(Boolean).join(' '):value;if(actual!==expected)fail('PDF_APPLY_OPS_VERIFY_FAILED')}
   verifyFormTargets(after,planned,s,survivingFields)
   verifyPdfWidgetEdits(after,planned.widgetEdits,resolvedWidgetEdits)
   verifyPdfOutline(after,planned.outline,planned.order)
   const actualLeaves=await readPdfLeafObjects(bytes,true,{normalizeSyntheticTextSuffix:true})
   const textTargets=s.textInserts.map(e=>e.input).filter(e=>planned.order.includes(e.pageIndex)).map(e=>({pageIndex:planned.order.indexOf(e.pageIndex),newText:e.text}))
   if(textTargets.length&&(await verifyTextEdits(bytes,textTargets)).length)fail('PDF_APPLY_OPS_VERIFY_FAILED')
   verifyOriginalContent(leaves,actualLeaves,s,planned.order);verifyAnnotations(after,s,planned,originalAnnots);await verifyImages(bytes,leaves,actualLeaves,s,planned.order,signal);check(signal)
   if(captured){
    bytes=await reapplyPdfManagedStamps(bytes,captured.operations,{allowAcroForm:true,signal})
   }
   for(const operation of s.stampOperations??[]){
    try{bytes=await reapplyPdfManagedStamps(bytes,[operation],{allowAcroForm:true,signal})}
    catch(error){if(error?.code!=='PDF_STAMP_NOT_FOUND')throw error}
   }
   const finalDoc=captured||s.stampOperations?.length?await open(bytes):after
   if(finalDoc!==after&&normalizedForm(finalDoc)!==expectedForm)fail('PDF_APPLY_OPS_VERIFY_FAILED')
   if(request.staticFormFills){
    const expected=staticFormFills.flatMap(fill=>{
     const pageIndex=planned.order.indexOf(fill.pageIndex)
     return pageIndex<0?[]:[{...fill,pageIndex}]
    })
    if(JSON.stringify(staticFormFillsFromCatalog(finalDoc))!==JSON.stringify(expected))fail('PDF_APPLY_OPS_VERIFY_FAILED')
   }
   check(signal)
   return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfApplyOpsSafetyCodes.has(error?.code))throw error;fail('NATIVE_FAILED')}finally{busy=false}
 }}
}
