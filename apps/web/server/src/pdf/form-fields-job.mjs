import {createHash} from 'node:crypto'
import {PDFDocument,PDFName,PDFArray,PDFDict,PDFNumber,PDFObjectCopier,PDFTextField,PDFCheckBox,PDFRadioGroup,PDFDropdown,PDFSignature,StandardFonts} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import {validatePdfFormFieldOperations} from '../../../../../packages/web-contracts/src/pdf-form-fields.ts'
import {pdfInsertFormState} from './insert-form-integrity.mjs'
import {openEditablePdf} from './editable-document.mjs'
import {viewToPdf,geomDispSize} from '../../../../pdf/src/renderer/annotations.ts'
export {validatePdfFormFieldOperations}
const n=PDFName.of,MAX_BYTES=64*1024*1024,hash=b=>createHash('sha256').update(b).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
export const pdfFormFieldsSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_FORM_FIELDS','PDF_FORM_FIELD_CONFLICT','PDF_FORM_FIELD_VERIFY_FAILED','PDF_TEXT_FONT_UNAVAILABLE','OUTPUT_LIMIT','PDF_FORM_INSERT_INTEGRITY_FAILED'])
export function parsePdfFormFieldsRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST');if(Buffer.byteLength(raw)>1024*1024)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!request||Array.isArray(request)||Object.keys(request).sort().join(',')!=='action,operations,version'||request.version!==1||request.action!=='formFields')fail('INVALID_REQUEST')
 return validatePdfFormFieldOperations(request.operations)
}
/** Form authoring permits existing unsigned signature widgets; signed documents stay immutable. */
async function openPdfForFormFields(bytes){
 const doc=await openEditablePdf(bytes,{allowAcroForm:true}),acro=doc.catalog.lookup(n('AcroForm'))
 if(acro!==undefined&&!(acro instanceof PDFDict)||acro?.has(n('XFA')))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 const pending=doc.context.enumerateIndirectObjects().map(([,value])=>value),seen=new Set()
 while(pending.length){
  const value=pending.pop();if(!value||seen.has(value))continue;seen.add(value)
  if(seen.size>100000)fail('PDF_EDIT_LIMIT')
  if(value instanceof PDFDict){
   if(String(value.lookup(n('Type')))==='/Sig'||value.has(n('ByteRange'))||String(value.lookup(n('FT')))==='/Sig'&&value.has(n('V'))&&String(value.lookup(n('V')))!=='null')fail('SIGNATURE_EDIT_REFUSED')
   pending.push(...value.values())
  }else if(value instanceof PDFArray)pending.push(...value.asArray())
  else if(value.dict instanceof PDFDict)pending.push(value.dict)
 }
 if(acro&&doc.getPages().some(page=>page.node.has(n('DyOfficeStamps'))))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 return doc
}
export function planPdfFormFields(doc,operations){
 const existing=doc.catalog.has(n('AcroForm'))?doc.getForm().getFields():[],radioOptions=new Map(existing.filter(f=>f instanceof PDFRadioGroup).map(f=>[f.getName(),[...f.getOptions()]]))
 return operations.map(({field:f})=>{
  if(existing.some(field=>{const name=field.getName();return name===f.name?f.kind!=='radio'||!(field instanceof PDFRadioGroup):name.startsWith(f.name+'.')||f.name.startsWith(name+'.')}))fail('PDF_FORM_FIELD_CONFLICT')
  let exportValue=f.exportValue
  if(f.kind==='radio'){
   const options=radioOptions.get(f.name)??[];exportValue=exportValue??`option_${options.length+1}`
   if(options.includes(exportValue))fail('PDF_FORM_FIELD_CONFLICT');radioOptions.set(f.name,[...options,exportValue])
  }
  const page=doc.getPage(f.page-1),crop=page.getCropBox(),media=page.getMediaBox(),unit=page.node.lookupMaybe(n('UserUnit'),PDFNumber)?.asNumber()??1,rot=((page.getRotation().angle%360)+360)%360
  if(![crop.x,crop.y,crop.width,crop.height,unit].every(Number.isFinite)||crop.width<=0||crop.height<=0||unit<=0||unit>75000||![0,90,180,270].includes(rot))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  const x0=Math.max(crop.x,media.x),y0=Math.max(crop.y,media.y),pw=Math.min(crop.x+crop.width,media.x+media.width)-x0,ph=Math.min(crop.y+crop.height,media.y+media.height)-y0
  if(pw<=0||ph<=0)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  const geom={pw:pw*unit,ph:ph*unit,x0,y0,rot,userUnit:unit},size=geomDispSize(geom)
  if(f.x+f.width>size.width+0.001||f.y+f.height>size.height+0.001||Math.min(f.width,f.height)/unit<=1)fail('INVALID_PDF_FORM_FIELDS')
  const a=viewToPdf(geom,f.x,f.y),b=viewToPdf(geom,f.x+f.width,f.y+f.height),{page:ignored,x,y,width,height,...rest}=f
  return {...rest,...(f.kind==='radio'?{exportValue}:{}),pageIndex:f.page-1,rect:[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])],...(f.fontSize?{fontSize:f.fontSize/unit}:{})}
 })
}
export async function updatePdfFormFieldAppearances(doc,fields,signal){
 const form=doc.getForm(),fonts=new Map()
 for(const f of fields){
  // PC creates checkbox/radio appearances eagerly; leave existing radio widgets untouched.
  if(['signature','radio','checkbox'].includes(f.kind))continue
  const field=form.getField(f.name)
  if(f.kind==='choice'){field.setOptions(f.options);if(f.value)field.select(f.value)}
  const text=[f.value??'',...(f.options??[])].join(''),key=/[^\x20-\x7e\r\n\t]/.test(text)?text:''
  let font=fonts.get(key)
  if(!font){
   if(key){const {resolveTextInsertFont}=await import('../../../../pdf/src/main/text-edit.ts');let resolved;try{resolved=await resolveTextInsertFont({text:key.replace(/[\r\n\t]/g,'')});doc.registerFontkit(fontkit);font=await doc.embedFont(resolved.bytes,{subset:false})}catch{fail('PDF_TEXT_FONT_UNAVAILABLE')}}
   else font=await doc.embedFont(StandardFonts.Helvetica)
   fonts.set(key,font)
  }
  field.defaultUpdateAppearances(font);check(signal)
 }
}
function verifyPreserved(before,after,fields){
 const expected=pdfInsertFormState(before),acro=before.catalog.lookup(n('AcroForm')),afterAcro=after.catalog.lookup(n('AcroForm'),PDFDict),copier=PDFObjectCopier.for(before.context,after.context)
 // Only V/Ff/Opt and old widget AS are deliberately affected by an existing-radio append.
 for(const field of before.catalog.has(n('AcroForm'))?before.getForm().getFields():[]){
  if(!(field instanceof PDFRadioGroup)||!fields.some(f=>f.name===field.getName()))continue
  const updated=after.getForm().getRadioGroup(field.getName())
  for(const key of ['V','Ff','Opt']){const old=field.acroField.dict.get(n(key));if(old===undefined)updated.acroField.dict.delete(n(key));else updated.acroField.dict.set(n(key),copier.copy(old))}
  const oldWidgets=field.acroField.getWidgets(),newWidgets=updated.acroField.getWidgets()
  for(let i=0;i<oldWidgets.length;i++){const old=oldWidgets[i].dict.get(n('AS'));if(old===undefined)newWidgets[i].dict.delete(n('AS'));else newWidgets[i].dict.set(n('AS'),copier.copy(old))}
 }
 // Existing parent groups can receive siblings, and old radio groups receive widgets.
 // Prune only the appended tail at every original Fields/Kids path, then compare the entire old tree.
 function prune(oldDict,newDict,key,depth=0){
  if(depth>64)fail('PDF_EDIT_LIMIT')
  const old=oldDict?.lookupMaybe(n(key),PDFArray),current=newDict.lookupMaybe(n(key),PDFArray),count=old?.size()??0
  if((current?.size()??0)<count)fail('PDF_FORM_FIELD_VERIFY_FAILED')
  for(let i=0;i<count;i++){
   const a=before.context.lookup(old.get(i)),b=after.context.lookup(current.get(i))
   if(!(a instanceof PDFDict)||!(b instanceof PDFDict))fail('PDF_FORM_FIELD_VERIFY_FAILED')
   prune(a,b,'Kids',depth+1)
  }
  if(current)while(current.size()>count)current.remove(current.size()-1)
  if(!old)newDict.delete(n(key))
 }
 prune(acro,afterAcro,'Fields')
 if(!acro)after.catalog.delete(n('AcroForm'))
 for(let i=0;i<before.getPageCount();i++){
  const old=before.getPage(i).node.Annots(),annots=after.getPage(i).node.Annots(),length=old?.size()??0
  if((annots?.size()??0)<length)fail('PDF_FORM_FIELD_VERIFY_FAILED')
  if(annots)while(annots.size()>length){const dict=after.context.lookup(annots.get(annots.size()-1));if(!(dict instanceof PDFDict)||String(dict.lookup(n('Subtype')))!=='/Widget')fail('PDF_FORM_FIELD_VERIFY_FAILED');annots.remove(annots.size()-1)}
 }
 if(pdfInsertFormState(after)!==expected)fail('PDF_FORM_INSERT_INTEGRITY_FAILED')
}
function verifyAdded(doc,fields,before){
 const form=doc.getForm(),names=new Set(fields.map(f=>f.name))
 for(const name of names){
  const added=fields.filter(f=>f.name===name),f=added[0],field=form.getField(name),prior=before.catalog.has(n('AcroForm'))?before.getForm().getFieldMaybe(name):undefined,offset=prior?.acroField.getWidgets().length??0,widgets=field.acroField.getWidgets().slice(offset)
  const type={text:PDFTextField,checkbox:PDFCheckBox,radio:PDFRadioGroup,choice:PDFDropdown,signature:PDFSignature}[f.kind]
  if(!(field instanceof type))fail('PDF_FORM_FIELD_VERIFY_FAILED')
  if(widgets.length!==added.length||field.isRequired()!==!!(prior?.isRequired()||added.some(f=>f.required)))fail('PDF_FORM_FIELD_VERIFY_FAILED')
  if(f.kind==='text'){
   if((field.getText()??'')!==(f.value??'')||field.isMultiline()!==!!f.multiLine||(field.getMaxLength()??0)!==(f.maxLen??0)||field.getAlignment()!==({left:0,center:1,right:2}[f.textAlignment??'left']))fail('PDF_FORM_FIELD_VERIFY_FAILED')
   if(f.fontSize){const size=field.acroField.getDefaultAppearance()?.match(/([0-9.]+)\s+Tf/);if(!size||Math.abs(Number(size[1])-f.fontSize)>0.02)fail('PDF_FORM_FIELD_VERIFY_FAILED')}
   if(f.dateFormat)for(const dict of [field.acroField.dict,...widgets.map(w=>w.dict)]){
    const actions=dict.lookupMaybe(n('AA'),PDFDict)
    for(const [key,script]of [['F',`AFDate_FormatEx("${f.dateFormat}");`],['K',`AFDate_KeystrokeEx("${f.dateFormat}");`]]){const action=actions?.lookupMaybe(n(key),PDFDict);if(String(action?.get(n('S')))!=='/JavaScript'||action?.lookup(n('JS'))?.decodeText?.()!==script)fail('PDF_FORM_FIELD_VERIFY_FAILED')}
   }
  }
  if(f.kind==='checkbox'&&field.isChecked()!==!!f.checked)fail('PDF_FORM_FIELD_VERIFY_FAILED')
  if(f.kind==='choice'&&(JSON.stringify(field.getOptions())!==JSON.stringify(f.options)||JSON.stringify(field.getSelected())!==JSON.stringify(f.value?[f.value]:[])))fail('PDF_FORM_FIELD_VERIFY_FAILED')
  if(f.kind==='radio'){
   const previous=prior?.getOptions()??[],options=[...previous,...added.map(f=>f.exportValue)],checked=added.find(f=>f.checked),selected=checked?.exportValue??prior?.getSelected()
   if(JSON.stringify(field.getOptions())!==JSON.stringify(options)||field.getSelected()!==selected||field.acroField.getFlags()!==((prior?.acroField.getFlags()??32768)|(added.some(f=>f.required)?2:0)))fail('PDF_FORM_FIELD_VERIFY_FAILED')
   if(prior){const old=prior.acroField.getWidgets(),current=field.acroField.getWidgets();for(let i=0;i<old.length;i++){const expected=checked?'/Off':String(old[i].getAppearanceState());if(String(current[i].getAppearanceState())!==expected)fail('PDF_FORM_FIELD_VERIFY_FAILED')}}
   for(let i=0;i<widgets.length;i++){const expected=added[i].exportValue===selected?String(widgets[i].getOnValue()):'/Off';if(String(widgets[i].getAppearanceState())!==expected)fail('PDF_FORM_FIELD_VERIFY_FAILED')}

  }
  for(let i=0;i<widgets.length;i++){
   const w=widgets[i],r=w.getRectangle(),rect=added[i].rect
   if([r.x-rect[0],r.y-rect[1],r.x+r.width-rect[2],r.y+r.height-rect[3]].some(delta=>Math.abs(delta)>0.02)||String(w.dict.get(n('P')))!==String(doc.getPage(added[i].pageIndex).ref))fail('PDF_FORM_FIELD_VERIFY_FAILED')
   if(f.kind==='signature'){if(field.acroField.dict.has(n('V'))||String(field.acroField.dict.lookup(n('FT')))!=='/Sig')fail('PDF_FORM_FIELD_VERIFY_FAILED')}
   else if(!w.dict.lookup(n('AP'),PDFDict)?.has(n('N')))fail('PDF_FORM_FIELD_VERIFY_FAILED')
  }
 }
}
export function createPdfFormFieldsJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY');if(!Buffer.isBuffer(input)||!input.length||input.length>MAX_BYTES)fail('INPUT_LIMIT')
  const operations=parsePdfFormFieldsRequest(raw),original=Buffer.from(input);busy=true
  try{
   const before=await openPdfForFormFields(original),doc=await openPdfForFormFields(original);validatePdfFormFieldOperations(operations,doc.getPageCount());const fields=planPdfFormFields(doc,operations);check(signal)
   const {applyFormFields}=await import('../../../../pdf/src/main/save-pdf.ts')
   const radioAppearance=new Map((doc.catalog.has(n('AcroForm'))?doc.getForm().getFields():[]).filter(f=>f instanceof PDFRadioGroup&&fields.some(op=>op.name===f.getName())).map(f=>[f.getName(),f.acroField.dict.get(n('DA'))]))
   applyFormFields(doc,fields.map(f=>f.kind==='choice'?{...f,options:[],value:undefined}:f))
   // Adding a widget must not replace the existing group's inherited appearance defaults.
   for(const [name,da]of radioAppearance){const dict=doc.getForm().getRadioGroup(name).acroField.dict;if(da===undefined)dict.delete(n('DA'));else dict.set(n('DA'),da)}
   await updatePdfFormFieldAppearances(doc,fields,signal)
   const bytes=Buffer.from(await doc.save({useObjectStreams:false,updateFieldAppearances:false}));check(signal);if(!bytes.length||bytes.length>MAX_BYTES)fail('OUTPUT_LIMIT')
   const after=await PDFDocument.load(bytes,{updateMetadata:false});if(after.getPageCount()!==before.getPageCount())fail('PDF_FORM_FIELD_VERIFY_FAILED');verifyAdded(after,fields,before);verifyPreserved(before,after,fields);check(signal)
   return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfFormFieldsSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
