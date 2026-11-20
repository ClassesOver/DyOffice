import {validatePdfFormFieldOperations,type PdfFormFieldOperation} from './pdf-form-fields'
import {validatePdfPageOperations,type PdfPageOperation} from './pdf-page-ops'

type CallablePageOperation=Extract<PdfPageOperation,{op:'rotatePages'|'deletePage'|'setPageOrder'|'setMetadata'}>
export type PdfApplyOperation=
 |CallablePageOperation
 |PdfFormFieldOperation
 |{readonly op:'removeMarkup';readonly id:string}
 |{readonly op:'setNoteContents';readonly id:string;readonly contents:string}
 |{readonly op:'removeTextInsert';readonly id:string}
 |{readonly op:'setFormValue';readonly value:Readonly<{name:string;value:string;checked?:never}|{name:string;checked:boolean;value?:never}>}

function fail():never{throw Object.assign(new Error('INVALID_PDF_APPLY_OPS'),{code:'INVALID_PDF_APPLY_OPS'})}
/** Copy data descriptors before calling reused validators, including their nested arrays. */
function snapshot(value:unknown,depth=0):unknown{
 if(depth>8)fail()
 if(!value||typeof value!=='object')return value
 if(Array.isArray(value)){
  if(value.length>100||Reflect.ownKeys(value).length!==value.length+1)fail()
  const result:unknown[]=[]
  for(let i=0;i<value.length;i++){
   const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)fail()
   result.push(snapshot(d.value,depth+1))
  }
  return Object.freeze(result)
 }
 if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail()
 const result:Record<string,unknown>=Object.create(null)
 for(const key of Reflect.ownKeys(value)){
  const d=Object.getOwnPropertyDescriptor(value,key)
  if(typeof key!=='string'||!d||!('value'in d)||!d.enumerable)fail()
  result[key]=snapshot(d.value,depth+1)
 }
 return Object.freeze(result)
}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
 return value as Record<string,unknown>
}
function pendingId(value:unknown,prefix:'P'|'T'):string{
 if(typeof value!=='string'||value.length<2||value.length>201||!value.startsWith(prefix)||/\s|[\u0000-\u001f\u007f]/.test(value))fail()
 return value
}
function text(value:unknown,max:number):value is string{return typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)}
/** Model-facing contract only: 1-based pages and explicit pending P/T ids remain unchanged.
 * Runtime writers must check document protection and atomic applicability under each op’s semantics.
 */
export function validatePdfApplyOperations(input:unknown,pageCount?:number):readonly PdfApplyOperation[]{
 if(pageCount!==undefined&&(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>100))fail()
 if(!Array.isArray(input)||input.length<1||input.length>50)fail()
 const items=snapshot(input) as readonly unknown[],operations:PdfApplyOperation[]=[],pages:CallablePageOperation[]=[],fields:PdfFormFieldOperation[]=[],deleted=new Set<number>()
 try{
  for(const raw of items){
   const item=record(raw,['op','id','contents','value','field','pages','dir','page','order','metadata'])
   if(item.op==='removeMarkup'||item.op==='removeTextInsert'){
    record(item,['op','id']);operations.push(Object.freeze({op:item.op,id:pendingId(item.id,item.op==='removeMarkup'?'P':'T')}))
   }else if(item.op==='setNoteContents'){
    record(item,['op','id','contents']);const id=pendingId(item.id,'P')
    if(!text(item.contents,10000)||!item.contents.trim())fail()
    operations.push(Object.freeze({op:item.op,id,contents:item.contents.trim()}))
   }else if(item.op==='setFormValue'){
    record(item,['op','value']);const value=record(item.value,['name','value','checked'])
    if(!text(value.name,1024)||!value.name.trim())fail()
    if('checked'in value){
     if('value'in value||typeof value.checked!=='boolean')fail()
     operations.push(Object.freeze({op:item.op,value:Object.freeze({name:value.name,checked:value.checked})}))
    }else{
     if(!text(value.value,10000))fail()
     operations.push(Object.freeze({op:item.op,value:Object.freeze({name:value.name,value:value.value})}))
    }
   }else if(item.op==='addFormField'){
    const field=validatePdfFormFieldOperations([item],pageCount)[0]!;if(deleted.has(field.field.page))fail();fields.push(field);operations.push(field)
   }else if(['rotatePages','deletePage','setPageOrder','setMetadata'].includes(item.op as string)){
    const page=validatePdfPageOperations([item])[0] as CallablePageOperation;pages.push(page);operations.push(page);if(page.op==='deletePage')deleted.add(page.page)
   }else fail()
  }
  // Preserve order within each family so duplicate names and page deletions/reorders are checked.
  if(fields.length)validatePdfFormFieldOperations(fields,pageCount)
  if(pages.length)validatePdfPageOperations(pages,pageCount)
 }catch{fail()}
 return Object.freeze(operations)
}
