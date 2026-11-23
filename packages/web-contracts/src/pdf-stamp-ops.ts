export type PdfWatermarkOperation={op:'set_watermark';text:string;angle?:number;opacity?:number;color?:string;size?:number}
export type PdfHeaderFooterOperation={op:'set_header_footer';header_left?:string;header_center?:string;header_right?:string;footer_left?:string;footer_center?:string;footer_right?:string;page_number?:boolean;start_at?:number;font_size?:number;color?:string}
export type PdfStampOperation=PdfWatermarkOperation|PdfHeaderFooterOperation
const slots=['header_left','header_center','header_right','footer_left','footer_center','footer_right']
const fields={set_watermark:['text','angle','opacity','color','size'],set_header_footer:[...slots,'page_number','start_at','font_size','color']}
const fail=():never=>{throw Object.assign(Error('INVALID_PDF_STAMP'),{code:'INVALID_PDF_STAMP'})}
/** 和PC工具共用的参数范围；只处理字面值，不填充依赖前版本的水印默认值。 */
export function validatePdfStampOperation(input:unknown):PdfStampOperation{
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail()
 const value=input as Record<string,unknown>,kind=Object.getOwnPropertyDescriptor(value,'op')
 if(!kind||!('value'in kind)||!Object.hasOwn(fields,kind.value))fail()
 const op=kind!.value as keyof typeof fields,allowed=['op',...fields[op]]
 for(const key of Reflect.ownKeys(value)){
  const d=Object.getOwnPropertyDescriptor(value,key)
  if(typeof key!=='string'||!allowed.includes(key)||!d?.enumerable||!('value'in d))fail()
 }
 const result={...value}
 for(const key of op==='set_watermark'?['text']:slots){
  if(op==='set_watermark'||key in value){
   if(typeof value[key]!=='string'||value[key].length>2000||/[\x00-\x1f\x7f]/.test(value[key]))fail()
   result[key]=(value[key] as string).trim()
  }
 }
 const ranges:Record<string,[number,number,boolean?]>={angle:[-180,180],opacity:[0,1],size:[.02,.5],start_at:[0,100000,true],font_size:[4,72]}
 for(const [key,[min,max,integer]] of Object.entries(ranges))if(key in value&&(typeof value[key]!=='number'||!Number.isFinite(value[key])||Number(value[key])<min||Number(value[key])>max||integer&&!Number.isInteger(value[key])))fail()
 if('color'in value&&(typeof value.color!=='string'||!/^#?[a-f0-9]{6}$/i.test(value.color)))fail()
 if('page_number'in value&&typeof value.page_number!=='boolean')fail()
 return Object.freeze(result) as PdfStampOperation
}
