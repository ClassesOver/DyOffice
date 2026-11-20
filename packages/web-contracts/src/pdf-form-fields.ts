export interface PdfFormField {
 readonly name:string
 readonly kind:'text'|'checkbox'|'radio'|'choice'|'signature'
 readonly page:number
 readonly x:number
 readonly y:number
 readonly width:number
 readonly height:number
 readonly required?:boolean
 readonly multiLine?:boolean
 readonly maxLen?:number
 readonly fontSize?:number
 readonly textAlignment?:'left'|'center'|'right'
 readonly value?:string
 readonly checked?:boolean
 readonly exportValue?:string
 readonly options?:readonly string[]
 readonly dateFormat?:string
}
export interface PdfFormFieldOperation {readonly op:'addFormField';readonly field:PdfFormField}
function fail():never{throw Object.assign(new Error('INVALID_PDF_FORM_FIELDS'),{code:'INVALID_PDF_FORM_FIELDS'})}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail()
 for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!keys.includes(key)||!d||!('value'in d)||!d.enumerable)fail()}
 return value as Record<string,unknown>
}
function list(value:unknown,max:number):unknown[]{
 if(!Array.isArray(value)||value.length<1||value.length>max||Reflect.ownKeys(value).length!==value.length+1)fail()
 const result:unknown[]=[]
 for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)fail();result.push(d.value)}
 return result
}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
export function validatePdfFormFieldOperations(input:unknown,pageCount?:number):readonly PdfFormFieldOperation[]{
 if(pageCount!==undefined&&(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>100))fail()
 const result:PdfFormFieldOperation[]=[],groups=new Map<string,PdfFormField[]>()
 for(const raw of list(input,50)){
  const op=record(raw,['op','field']);if(op.op!=='addFormField')fail()
  const base=['name','kind','page','x','y','width','height','required'],given=record(op.field,[...base,'multiLine','maxLen','fontSize','textAlignment','value','checked','exportValue','options','dateFormat'])
  if(typeof given.kind!=='string'||!['text','checkbox','radio','choice','signature'].includes(given.kind))fail()
  const extra=({text:['multiLine','maxLen','fontSize','textAlignment','value','dateFormat'],checkbox:['checked'],radio:['checked','exportValue'],choice:['options','value'],signature:[]} as Record<string,string[]>)[String(given.kind)]
  if(!extra||Object.keys(given).some(key=>![...base,...extra].includes(key)))fail()
  if(!text(given.name,200)||!given.name.trim()||given.name!==given.name.trim()||given.name.split('.').some(part=>!part.trim())||/[\r\n\t]/.test(given.name))fail()
  if(!Number.isSafeInteger(given.page)||(given.page as number)<1||(given.page as number)>(pageCount??100))fail()
  for(const key of ['x','y','width','height'])if(typeof given[key]!=='number'||!Number.isFinite(given[key])||(given[key] as number)<0||(given[key] as number)>14400||['width','height'].includes(key)&&(given[key] as number)<=0)fail()
  for(const key of ['required','multiLine','checked'])if(key in given&&typeof given[key]!=='boolean')fail()
  if('maxLen'in given&&(!Number.isSafeInteger(given.maxLen)||(given.maxLen as number)<0||(given.maxLen as number)>10000))fail()
  if('fontSize'in given&&(typeof given.fontSize!=='number'||!Number.isFinite(given.fontSize)||given.fontSize<=0||given.fontSize>1000))fail()
  if('textAlignment'in given&&(typeof given.textAlignment!=='string'||!['left','center','right'].includes(given.textAlignment)))fail()
  if('value'in given&&(!text(given.value,10000)||given.maxLen&&(given.value as string).length>(given.maxLen as number)))fail()
  if('exportValue'in given&&(!text(given.exportValue,200)||!(given.exportValue as string).trim()||/[\r\n\t]/.test(given.exportValue as string)))fail()
  if('dateFormat'in given&&(typeof given.dateFormat!=='string'||!/^[ymdHhsM :/.,年月日时分秒-]{1,64}$/.test(given.dateFormat)))fail()
  let options:readonly string[]|undefined
  if(given.kind==='choice'){
   options=Object.freeze((given.options===undefined||Array.isArray(given.options)&&given.options.length===0&&Reflect.ownKeys(given.options).length===1?[]:list(given.options,100)).map(value=>{if(!text(value,1000)||!value.trim()||value!==value.trim())fail();return value}))
   if(new Set(options).size!==options.length||given.value!==undefined&&given.value!==''&&!options.includes(given.value as string))fail()
  }
  const field=Object.freeze({...given,...(options?{options}:{})}) as unknown as PdfFormField
  for(const [name,prior]of groups){
   if(name===field.name){if(field.kind!=='radio'||prior.some(f=>f.kind!=='radio')||field.exportValue!==undefined&&prior.some(f=>f.exportValue===field.exportValue)||field.checked&&prior.some(f=>f.checked))fail()}
   else if(name.startsWith(field.name+'.')||field.name.startsWith(name+'.'))fail()
  }
  groups.set(field.name,[...(groups.get(field.name)??[]),field]);result.push(Object.freeze({op:'addFormField',field}))
 }
 return Object.freeze(result)
}
