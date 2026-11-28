import type {WebFile} from './web-home-bridge'
import {isEncryptedOfficeFormat,type EncryptedOfficeFormat} from '../../../../packages/web-contracts/src/api'
export type SessionEndReason='expired'|'logout_failed'
export class IncorrectOfficeUploadPassword extends Error {}
/** Local mode only: HttpOnly session cookies, ephemeral CSRF, no bearer/JSON fallback. */
export function createLocalShellClient(send:typeof fetch=fetch) {
 let csrf:string|undefined
 let passwordAction:'idle'|'pending'|'unknown'='idle'
 let generation=0
 let authTransition=false
 const pending=new Set<AbortController>()
 const sessionListeners=new Set<(reason:SessionEndReason)=>void>()
 function endSession(reason:SessionEndReason){
  // Requests invalidated by an explicit account transition must not cancel that transition.
  if(authTransition&&reason==='expired')return
  invalidateSession();for(const listener of sessionListeners)listener(reason)
 }
 const stale=()=>Object.assign(new Error('登录状态已改变，请重新加载当前工作区。'),{code:'stale_session'})
 function assertCurrent(stamp:number){if(stamp!==generation)throw stale()}
 function invalidateSession(){
  generation++;csrf=undefined
  for(const controller of pending)controller.abort()
  pending.clear()
 }
 async function perform<T=unknown>(path:string,method='GET',body?:unknown,stamp=generation,sessionProof?:string,signal?:AbortSignal,decode?: (response:Response)=>Promise<T>,encryptedFormat?:EncryptedOfficeFormat):Promise<T>{
  if(!path.startsWith('/api/v1/')||path.includes('\\')||path.includes('#'))throw new Error('Expected same-origin local API path')
  assertCurrent(stamp)
  signal?.throwIfAborted()
  const write=!['GET','HEAD'].includes(method)
  if(write&&!csrf&&!sessionProof){const result=await perform<{csrfToken:string}>('/api/v1/auth/csrf','GET',undefined,stamp,undefined,signal);assertCurrent(stamp);signal?.throwIfAborted();csrf=result.csrfToken}
  assertCurrent(stamp)
  const binary=body instanceof Blob
  const controller=new AbortController();pending.add(controller)
  const abort=()=>controller.abort(signal?.reason)
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
  try{
   const response=await send(path,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,...(decode||encryptedFormat||path.endsWith('/sheets/unlock')?{redirect:'error' as const}:{}),headers:{...(write||sessionProof?{'X-CSRF-Token':sessionProof??csrf!}:{}),...(encryptedFormat==='docx'?{'X-DyOffice-Open-After-Import':'1'}:{}),...(body!==undefined?{'Content-Type':encryptedFormat?`application/vnd.dyoffice.encrypted-${encryptedFormat}`:binary?'application/octet-stream':'application/json'}:{})},...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})})
   assertCurrent(stamp)
   signal?.throwIfAborted()
   const value=response.ok&&decode?await decode(response):response.status===204?undefined:await response.json().catch(error=>{if(response.ok)throw error;return undefined})
   assertCurrent(stamp)
   signal?.throwIfAborted()
   if(!response.ok){
    if(response.status===401&&path!=='/api/v1/auth/login'&&path!=='/api/v1/auth/change-password')endSession('expired')
    else if(response.status===403)csrf=undefined
    const message=response.status===409&&path.startsWith('/api/v1/admin/config')?'配置已被更新，请读取最新配置并核对；当前草稿已保留。'
     :response.status===409&&path.startsWith('/api/v1/workspace/folders')?'文件夹操作冲突：请检查重名、非空目录或移动目标，再刷新重试。'
     :response.status===400&&path.startsWith('/api/v1/workspace/folders')?'文件夹名称或移动目标无效，请检查名称长度、路径符号及目标目录。'
     :value?.message||value?.title||value?.error||'请求失败'
    throw Object.assign(new Error(message),{status:response.status,...(typeof value?.code==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(value.code)?{code:value.code}:{})})
   }
   return value as T
  }catch(error){if((error as {status?:number})?.status!==401)assertCurrent(stamp);signal?.throwIfAborted();throw error}
  finally{pending.delete(controller);signal?.removeEventListener('abort',abort)}
 }
 async function request<T=unknown>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  if(authTransition)throw stale()
  return perform<T>(path,method,body,generation,undefined,signal)
 }
 async function bindSession(expectedProof?:string,signal?:AbortSignal){
   const stamp=generation
   const {csrfToken}=await request<{csrfToken:string}>('/api/v1/auth/session-proof','GET',undefined,signal)
   assertCurrent(stamp)
   if(!/^[A-Za-z0-9_-]{43}$/.test(csrfToken)||(expectedProof!==undefined&&expectedProof!==csrfToken))throw stale()
   async function verifySession(requestSignal?:AbortSignal){
    // A rotated cookie can arrive in another tab before its page navigates.
    try{
     const current=await perform<{csrfToken:string}>('/api/v1/auth/session-proof','GET',undefined,stamp,undefined,requestSignal)
     if(current.csrfToken!==csrfToken)throw stale()
    }catch(cause){requestSignal?.throwIfAborted();throw Object.assign(stale(),{cause})}
   }
   return {
    proof:csrfToken,
    async request<T=unknown>(path:string,method='GET',body?:unknown,requestSignal?:AbortSignal,encryptedFormat?:EncryptedOfficeFormat){
     const result=await perform<T>(path,method,body,stamp,csrfToken,requestSignal,undefined,encryptedFormat)
     await verifySession(requestSignal)
     return result
    },
    async download(path:string,options?:{body:unknown;signal?:AbortSignal}){
     const blob=await perform<Blob>(path,options?'POST':'GET',options?.body,stamp,csrfToken,options?.signal,async response=>{
      if(response.headers.get('content-type')?.split(';',1)[0]!=='application/octet-stream'){
       await response.body?.cancel()
       throw new Error('未收到有效的下载文件。')
      }
      return response.blob()
     })
     await verifySession(options?.signal)
     return blob
    },
   }
  }
 return {
  request,
  endSession,
  onSessionEnded(listener:(reason:SessionEndReason)=>void){sessionListeners.add(listener);return()=>{sessionListeners.delete(listener)}},
  bindSession,
  invalidateSession,
  invalidateCsrf(){csrf=undefined},
  async changePassword(currentPassword:string,newPassword:string){
   if(passwordAction!=='idle')throw new Error(passwordAction==='pending'?'密码修改正在进行中。':'无法确认上次密码修改结果，请重新加载。')
   passwordAction='pending'
   try{
    const result=await request<{csrfToken:string}>('/api/v1/auth/change-password','POST',{currentPassword,newPassword})
    if(!result||typeof result.csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.csrfToken))throw new Error('无法确认密码修改结果。')
    csrf=result.csrfToken;passwordAction='idle';return result.csrfToken
   }catch(error){
    csrf=undefined
    const status=(error as {status?:number})?.status
    if(status===401){try{await request('/api/v1/auth/me')}catch{}}
    passwordAction=status!==undefined&&status>=400&&status<500&&status!==408?'idle':'unknown'
    throw error
   }
  },
  async login(username:string,password:string){
   if(authTransition)throw new Error('登录状态正在更新。')
   authTransition=true;invalidateSession();passwordAction='idle'
   try{const result=await perform<{user:{id:string;username:string;displayName:string;roles:string[]};csrfToken:string}>('/api/v1/auth/login','POST',{username,password});return result.user}
   finally{csrf=undefined;authTransition=false}
  },
  async logout(){
   if(authTransition)throw new Error('登录状态正在更新。')
   authTransition=true;invalidateSession()
   try{await perform('/api/v1/auth/logout','POST')}
   catch(error){endSession('logout_failed');throw error}
   finally{csrf=undefined;authTransition=false}
  },
  async homeRequest(path:string,method='GET',body?:unknown):Promise<unknown>{
   if(path==='/preferences')return request('/api/v1/preferences',method,body)
   if(path!=='/files'||method!=='GET')throw new Error('Unsupported local Home operation')
   const files:WebFile[]=[];const seen=new Set<string>();let cursor:string|null=null
   do{const page:{files:WebFile[];nextCursor:string|null}=await request<{files:WebFile[];nextCursor:string|null}>(`/api/v1/files?limit=100${cursor?'&cursor='+encodeURIComponent(cursor):''}`);files.push(...page.files);cursor=page.nextCursor;if(cursor){if(seen.has(cursor))throw new Error('Invalid file pagination');seen.add(cursor)}}while(cursor)
   return files
  },
  async upload(file:File,expectedProof:string,autoName=false,password?:string){
   if(!expectedProof)throw stale()
   if(file.size>32*1024*1024)throw new Error('文件超过 32 MiB 限制')
   const extension=file.name.split('.').pop()?.toLowerCase()
   const encryptedFormat=password!==undefined&&extension&&isEncryptedOfficeFormat(extension)?extension:undefined
   if(password!==undefined&&(!encryptedFormat||!password.length||password.length>255))throw new Error('请输入有效的打开密码。')
   const bound=await bindSession(expectedProof)
   // Files dragged onto a native editor are created in the iframe's realm.
   let content=file instanceof Blob?file:new Blob([file])
   const needsConversion=extension==='tsv'||extension==='xls'||extension==='ods'||extension==='ots'
   if(needsConversion)content=await bound.download(`/api/v1/files/convert-${extension}`,{body:content})
   const stage=await bound.request<{uploadId:string}>('/api/v1/files/uploads','POST',{name:needsConversion?file.name.slice(0,-4)+'.xlsx':file.name,size:needsConversion?content.size:file.size,...(autoName?{autoName:true}:{})})
   const path=`/api/v1/uploads/${encodeURIComponent(stage.uploadId)}`
   if(password!==undefined){
    const encoded=new TextEncoder().encode(password)
    const prefix=new Uint8Array(2)
    new DataView(prefix.buffer).setUint16(0,encoded.length)
    content=new Blob([prefix,encoded,content])
    encoded.fill(0)
   }
   let ready:{unlockId?:string}|undefined
   try{ready=await bound.request(path+'/content','PUT',content,undefined,encryptedFormat)}
   catch(error){
    if(password!==undefined&&(error as {status?:number})?.status===422)throw new IncorrectOfficeUploadPassword('打开密码错误。')
    throw error
   }
   // A failed finish may have committed: never retry or cancel it automatically.
   const result=await bound.request<{file:{fileId:string;revision:string};format:string}>(path+'/finish','POST')
   return {...result,...(encryptedFormat==='docx'&&result.format==='docx'&&typeof ready?.unlockId==='string'&&/^[\da-f-]{36}$/.test(ready.unlockId)?{unlockId:ready.unlockId}:{})}
  },
 }
}
