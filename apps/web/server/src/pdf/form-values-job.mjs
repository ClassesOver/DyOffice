import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {PDFCheckBox,PDFTextField,PDFRadioGroup,PDFDropdown,PDFOptionList,PDFSignature,PDFButton,PDFAcroNonTerminal,PDFName,PDFDict,PDFArray,StandardFonts} from 'pdf-lib'
import {openEditablePdf} from './editable-document.mjs'
import {pdfFontkit} from '../../../src/editors/pdf-fontkit.ts'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fail(code){throw Object.assign(new Error(code),{code})}
function check(signal){if(signal?.aborted)fail('ABORTED')}
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key)?.enumerable&&'value'in Object.getOwnPropertyDescriptor(value,key))
export const pdfFormValuesSafetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','INVALID_PDF_FORM_VALUES','PDF_FORM_VERIFY_FAILED','PDF_FORM_FONT_UNAVAILABLE','OUTPUT_LIMIT'])
export function validatePdfFormValueOperations(input){
 if(!Array.isArray(input)||input.length<1||input.length>100||Reflect.ownKeys(input).length!==input.length+1)fail('INVALID_PDF_FORM_VALUES')
 const seen=new Set(),result=[]
 for(let i=0;i<input.length;i++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(i));if(!descriptor||!('value'in descriptor))fail('INVALID_PDF_FORM_VALUES')
  const op=descriptor.value
  if(!plain(op)||Object.keys(op).sort().join(',')!=='op,value'||op.op!=='setFormValue'||!plain(op.value))fail('INVALID_PDF_FORM_VALUES')
  const value=op.value
  if(Object.keys(value).some(key=>!['name','value','checked'].includes(key))||typeof value.name!=='string'||!value.name||value.name.length>1024||value.name.includes('\0')||seen.has(value.name))fail('INVALID_PDF_FORM_VALUES')
  if(('value'in value&&('checked'in value||typeof value.value!=='string'||value.value.length>10000||value.value.includes('\0')))||('checked'in value&&typeof value.checked!=='boolean')||(!('value'in value)&&!('checked'in value)))fail('INVALID_PDF_FORM_VALUES')
  seen.add(value.name);result.push(Object.freeze({op:'setFormValue',value:Object.freeze({...value})}))
 }
 return Object.freeze(result)
}
export function parsePdfFormValuesRequest(raw){
 if(typeof raw!=='string')fail('INVALID_REQUEST')
 if(Buffer.byteLength(raw)>1024*1024)fail('REQUEST_LIMIT')
 let request;try{request=JSON.parse(raw)}catch{fail('INVALID_REQUEST')}
 if(!plain(request)||Object.keys(request).sort().join(',')!=='action,operations,version'||request.version!==1||request.action!=='formValues')fail('INVALID_REQUEST')
 return validatePdfFormValueOperations(request.operations)
}
export function pdfFormValueFields(doc){
 const acro=doc.catalog.lookup(PDFName.of('AcroForm'))
 if(acro instanceof PDFDict&&acro.has(PDFName.of('XFA')))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 const form=doc.getForm()
 let list;try{list=form.getFields()}catch{fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')}
 const raw=form.acroForm.getAllFields()
 if(raw.length>1000)fail('PDF_EDIT_LIMIT')
 if(raw.filter(([field])=>!(field instanceof PDFAcroNonTerminal)).length!==list.length)fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
 const map=new Map()
 for(const field of list){
  if(map.has(field.getName())||![PDFTextField,PDFCheckBox,PDFRadioGroup,PDFDropdown,PDFOptionList,PDFSignature,PDFButton].some(Type=>field instanceof Type))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  map.set(field.getName(),field)
 }
 return map
}
export function preparePdfFormValues(doc,operations){
 const map=pdfFormValueFields(doc)
 return operations.map(({value})=>{
  const field=map.get(value.name)
  if(!field||field.isReadOnly()||(field instanceof PDFSignature||field instanceof PDFButton))fail('INVALID_PDF_FORM_VALUES')
  if(field.acroField.getWidgets().length<1||field.acroField.getWidgets().some(widget=>{const rect=widget.dict.lookup(PDFName.of('Rect'));return !(rect instanceof PDFArray)||rect.size()!==4||!rect.asArray().every(n=>typeof n?.asNumber==='function'&&Number.isFinite(n.asNumber()))}))fail('PDF_EDIT_UNSUPPORTED_STRUCTURE')
  if(field instanceof PDFCheckBox){if(typeof value.checked!=='boolean'||'value'in value)fail('INVALID_PDF_FORM_VALUES');return {...value,kind:'checkbox'}}
  if(typeof value.value!=='string'||'checked'in value)fail('INVALID_PDF_FORM_VALUES')
  if(field instanceof PDFTextField){const max=field.getMaxLength();if(max!==undefined&&value.value.length>max)fail('INVALID_PDF_FORM_VALUES');return {...value,kind:'text'}}
  if(value.value&&!field.getOptions().includes(value.value))fail('INVALID_PDF_FORM_VALUES')
  return {...value,kind:field instanceof PDFRadioGroup?'radio':'choice'}
 })
}
function current(field){return field instanceof PDFTextField?field.getText()??'':field instanceof PDFCheckBox?field.isChecked():field instanceof PDFRadioGroup?field.getSelected()??'':field.getSelected()}
export async function updatePdfFormValueAppearances(doc,names,signal){
 const map=pdfFormValueFields(doc)
 doc.registerFontkit(pdfFontkit)
 let latin,cjk
 const appearanceFields=names.map(name=>{const field=map.get(name);if(!field||field instanceof PDFSignature)fail('INVALID_PDF_FORM_VALUES');return field})
   for(const field of appearanceFields){
    if(field instanceof PDFCheckBox||field instanceof PDFRadioGroup){field.defaultUpdateAppearances();continue}
    const text=field instanceof PDFTextField?field.getText()??'':field instanceof PDFButton?field.acroField.getWidgets().flatMap(widget=>Object.values(widget.getAppearanceCharacteristics()?.getCaptions()??{})).filter(Boolean).join(''):field.getOptions().join('')
    let font
    if(/^[\x00-\x7f]*$/.test(text))font=latin??=await doc.embedFont(StandardFonts.Helvetica)
    else{
     cjk??=await doc.embedFont(await readFile(new URL('../../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2',import.meta.url)),{subset:true})
     font=cjk
     const covers=f=>{const chars=new Set(f.getCharacterSet());return Array.from(text).every(char=>/[\r\n\t]/.test(char)||chars.has(char.codePointAt(0)))}
     if(!covers(font)){
      const {fallbackFontFor}=await import('../../../../pdf/src/main/text-edit.ts'),bytes=fallbackFontFor(text)
      if(!bytes)fail('PDF_FORM_FONT_UNAVAILABLE')
      font=await doc.embedFont(bytes,{subset:true});if(!covers(font))fail('PDF_FORM_FONT_UNAVAILABLE')
     }
    }
    field.defaultUpdateAppearances(font)
   }
 check(signal)
}
export function createPdfFormValuesJob(){
 let busy=false
 return {async execute(input,raw,signal){
  check(signal);if(busy)fail('BUSY')
  if(!Buffer.isBuffer(input)||input.length<1||input.length>64*1024*1024)fail('INPUT_LIMIT')
  const operations=parsePdfFormValuesRequest(raw),original=Buffer.from(input);busy=true
  try{
   const before=await openEditablePdf(original,{allowAcroForm:true}),values=preparePdfFormValues(before,operations);check(signal)
   const {applySaveRequest}=await import('../../../../pdf/src/main/save-pdf.ts')
   const applied=await applySaveRequest(original,{formValues:values,markups:[],drawings:[],rotations:[]});check(signal)
   const doc=await openEditablePdf(Buffer.from(applied.bytes),{allowAcroForm:true}),map=pdfFormValueFields(doc),form=doc.getForm()
   const refreshAll=[before.getForm(),form].some(item=>String(item.acroForm.dict.get(PDFName.of('NeedAppearances')))==='true')
   const names=refreshAll?[...map.values()].filter(field=>!(field instanceof PDFSignature)).map(field=>field.getName()):values.map(value=>value.name)
   await updatePdfFormValueAppearances(doc,names,signal)
   // Every changed widget now has a concrete appearance, independent of viewer regeneration.
   form.acroForm.dict.delete(PDFName.of('NeedAppearances'))
   const expected=new Map([...pdfFormValueFields(before)].filter(([,field])=>!(field instanceof PDFSignature)&&!(field instanceof PDFButton)).map(([name,field])=>[name,current(field)]))
   for(const value of values)expected.set(value.name,value.kind==='checkbox'?value.checked:value.kind==='choice'?(value.value?[value.value]:[]):value.value)
   const bytes=Buffer.from(await doc.save({updateFieldAppearances:false}));check(signal)
   if(bytes.length>64*1024*1024)fail('OUTPUT_LIMIT')
   const after=await openEditablePdf(bytes,{allowAcroForm:true}),actual=pdfFormValueFields(after)
   if(after.getPageCount()!==before.getPageCount()||actual.size!==map.size)fail('PDF_FORM_VERIFY_FAILED')
   for(const [name,value]of expected)if(JSON.stringify(current(actual.get(name)))!==JSON.stringify(value))fail('PDF_FORM_VERIFY_FAILED')
   for(const value of values)for(const widget of actual.get(value.name).acroField.getWidgets()){
    const ap=widget.dict.lookup(PDFName.of('AP'))
    if(!(ap instanceof PDFDict)||!ap.has(PDFName.of('N')))fail('PDF_FORM_VERIFY_FAILED')
   }
   return {bytes,inputSha256:hash(original),sha256:hash(bytes),size:bytes.length}
  }catch(error){check(signal);if(pdfFormValuesSafetyCodes.has(error?.code))fail(error.code);fail('NATIVE_FAILED')}
  finally{busy=false}
 }}
}
