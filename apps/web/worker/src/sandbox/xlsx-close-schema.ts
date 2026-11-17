import {DocumentContractError} from './document-profiles.ts'
export interface XlsxCloseValue {readonly closed:true}
function bad():never {throw new DocumentContractError('INVALID_XLSX_CLOSE')}
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad()
 const names=Reflect.ownKeys(value)
 if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))bad()
 const out:Record<string,unknown>=Object.create(null)
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)bad();out[key]=d.value}
 return out
}
export function validateXlsxCloseValue(value:unknown):XlsxCloseValue {
 const v=record(value,['closed']);if(v.closed!==true)bad();return Object.freeze({closed:true})
}
/** Rust accepts String IDs; the NEW unified transport fixes canonical UUID request IDs.
 * This validates a successful engine close frame, never process termination.
 */
export function validateXlsxCloseFrame(value:unknown,expectedRequestId:string):XlsxCloseValue {
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(expectedRequestId))bad()
 const v=record(value,['version','requestId','ok','result'])
 if(v.version!==1||v.ok!==true||v.requestId!==expectedRequestId)bad()
 return validateXlsxCloseValue(v.result)
}
