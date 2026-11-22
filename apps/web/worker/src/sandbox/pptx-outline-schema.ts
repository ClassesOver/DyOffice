import {DocumentContractError} from './document-profiles.ts'
export interface PptxOutline {
 readonly count:number
 readonly size:Readonly<{cx:number;cy:number}>
 readonly slideIds:readonly string[]
 readonly paths:readonly string[]
 readonly defaultFont?:string
 readonly writeProtected?:true
}
/** Conservative NEW wire limits; the old outline method does not enforce these bounds. */
export const PPTX_OUTLINE_LIMITS=Object.freeze({slides:1500,emu:2147483647,pathChars:1024,fontChars:256})
function bad():never {throw new DocumentContractError('INVALID_PPTX_OUTLINE')}
function record(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad()
 const names=Reflect.ownKeys(value),allowed=[...required,...optional]
 if(names.some(k=>typeof k!=='string'||!allowed.includes(k))||required.some(k=>!names.includes(k)))bad()
 const result:Record<string,unknown>=Object.create(null)
 for(const key of names){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)bad();result[key as string]=d.value}
 return result
}
function strings(value:unknown,count:number):string[]{
 if(!Array.isArray(value)||value.length!==count||Reflect.ownKeys(value).length!==count+1)bad()
 const out:string[]=[]
 for(let i=0;i<count;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable||typeof d.value!=='string')bad();out.push(d.value)}
 return out
}
export function validatePptxOutline(value:unknown):PptxOutline{
 const v=record(value,['count','size','slideIds','paths'],['defaultFont','writeProtected'])
 if(!Number.isSafeInteger(v.count)||(v.count as number)<0||(v.count as number)>PPTX_OUTLINE_LIMITS.slides)bad()
 const count=v.count as number,size=record(v.size,['cx','cy'])
 for(const k of ['cx','cy'])if(!Number.isSafeInteger(size[k])||(size[k] as number)<1||(size[k] as number)>PPTX_OUTLINE_LIMITS.emu)bad()
 const paths=strings(v.paths,count),slideIds=strings(v.slideIds,count)
 for(let i=0;i<count;i++){
  const path=paths[i]!
  // These are archive identities, never host filesystem paths; do not normalize aliases.
  if(path.length<1||path.length>PPTX_OUTLINE_LIMITS.pathChars||!path.startsWith('ppt/')||!path.endsWith('.xml')||/[\\\u0000-\u0020\u007f?#:%]/.test(path)||path.split('/').some(x=>!x||x==='.'||x==='..'))bad()
  const match=/slide(\d+)\.xml$/.exec(path)
  const expected=match?`s_${match[1]}`:`s_${path.replace(/[^a-zA-Z0-9]/g,'_')}`
  if(slideIds[i]!==expected)bad()
 }
 if(new Set(paths).size!==count||new Set(slideIds).size!==count)bad()
 let font:string|undefined
 if(Object.hasOwn(v,'defaultFont')){if(typeof v.defaultFont!=='string'||v.defaultFont.length>PPTX_OUTLINE_LIMITS.fontChars||/[\u0000-\u001f\u007f]/.test(v.defaultFont))bad();font=v.defaultFont}
 if(Object.hasOwn(v,'writeProtected')&&v.writeProtected!==true)bad()
 return Object.freeze({
  count,size:Object.freeze({cx:size.cx as number,cy:size.cy as number}),slideIds:Object.freeze(slideIds),paths:Object.freeze(paths),
  ...(font===undefined?{}:{defaultFont:font}),
  ...(v.writeProtected===true?{writeProtected:true as const}:{}),
 })
}
