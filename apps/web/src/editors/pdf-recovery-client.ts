export type PdfRecoveryResult={state:'unresolved'}|{state:'committed';revision:{fileId:string;revision:string;sha256:string;size:number}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const invalid=()=>new Error('无法确认 PDF 保存回执，请重新登录或稍后手动查询；不要重复提交保存。')
/** Optional protocol adapter, not mounted in the PDF entry. No persistence,
 * polling, save replay or cached authorization. A receipt is not proof of PDF
 * semantics; unresolved and transport failure never establish save failure.
 */
export function createPdfRecoveryClient(send:typeof fetch=fetch){
 async function request(path:string,options:RequestInit={}){
  const response=await send(path,{...options,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'})
  if(response.status!==200)throw invalid()
  return response.json()
 }
 return Object.freeze({async lookup(fileId:string,idempotencyKey:string):Promise<PdfRecoveryResult>{
  try{
   if(typeof fileId!=='string'||!uuid.test(fileId)||typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))throw invalid()
   const {csrfToken}=await request('/api/v1/auth/csrf')
   if(typeof csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(csrfToken))throw invalid()
   const result=await request('/api/v1/pdf-recovery/lookup',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({fileId,idempotencyKey})})
   if(result?.state==='unresolved'&&!Object.hasOwn(result,'revision'))return Object.freeze({state:'unresolved'})
   const ref=result?.revision
   if(result?.state!=='committed'||!ref||ref.fileId!==fileId.toLowerCase()||typeof ref.revision!=='string'||!uuid.test(ref.revision)||typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256)||!Number.isSafeInteger(ref.size)||ref.size<1)throw invalid()
   return Object.freeze({state:'committed',revision:Object.freeze({fileId:ref.fileId,revision:ref.revision,sha256:ref.sha256,size:ref.size})})
  }catch{throw invalid()}
 }})
}
