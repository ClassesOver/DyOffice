import type {WebFile} from './web-home-bridge'
/** Local mode only: HttpOnly session cookies, ephemeral CSRF, no bearer/JSON fallback. */
export function createLocalShellClient(send:typeof fetch=fetch) {
 let csrf:string|undefined
 let passwordAction:'idle'|'pending'|'unknown'='idle'
 let generation=0
 let authTransition=false
 const pending=new Set<AbortController>()
 const stale=()=>Object.assign(new Error('登录状态已改变，请重新加载当前工作区。'),{code:'stale_session'})
 function assertCurrent(stamp:number){if(stamp!==generation)throw stale()}
 function invalidateSession(){
  generation++;csrf=undefined
  for(const controller of pending)controller.abort()
  pending.clear()
 }
 async function perform<T=unknown>(path:string,method='GET',body?:unknown,stamp=generation,sessionProof?:string):Promise<T>{
  if(!path.startsWith('/api/v1/')||path.includes('\\')||path.includes('#'))throw new Error('Expected same-origin local API path')
  assertCurrent(stamp)
  const write=!['GET','HEAD'].includes(method)
  if(write&&!csrf&&!sessionProof){const result=await perform<{csrfToken:string}>('/api/v1/auth/csrf','GET',undefined,stamp);assertCurrent(stamp);csrf=result.csrfToken}
  assertCurrent(stamp)
  const binary=body instanceof Blob
  const controller=new AbortController();pending.add(controller)
  try{
   const response=await send(path,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{...(write||sessionProof?{'X-CSRF-Token':sessionProof??csrf!}:{}),...(body!==undefined?{'Content-Type':binary?'application/octet-stream':'application/json'}:{})},...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})})
   assertCurrent(stamp)
   const value=response.status===204?undefined:await response.json()
   assertCurrent(stamp)
   if(!response.ok){
    if(response.status===401&&path!=='/api/v1/auth/login'&&path!=='/api/v1/auth/change-password')invalidateSession()
    else if(response.status===403)csrf=undefined
    const message=response.status===409&&path.startsWith('/api/v1/admin/config')?'配置版本冲突，请核对最新版本；当前草稿已保留。'
     :response.status===409&&path.startsWith('/api/v1/workspace/folders')?'文件夹操作冲突：请检查重名、非空目录或移动目标，再刷新重试。'
     :response.status===400&&path.startsWith('/api/v1/workspace/folders')?'文件夹名称或移动目标无效，请检查名称长度、路径符号及目标目录。'
     :value?.message||value?.title||value?.error||'请求失败'
    throw Object.assign(new Error(message),{status:response.status})
   }
   return value as T
  }catch(error){if((error as {status?:number})?.status!==401)assertCurrent(stamp);throw error}
  finally{pending.delete(controller)}
 }
 async function request<T=unknown>(path:string,method='GET',body?:unknown):Promise<T>{
  if(authTransition)throw stale()
  return perform<T>(path,method,body)
 }
 return {
  request,
  async bindSession(expectedProof?:string){
   const stamp=generation
   const {csrfToken}=await request<{csrfToken:string}>('/api/v1/auth/session-proof')
   assertCurrent(stamp)
   if(!/^[A-Za-z0-9_-]{43}$/.test(csrfToken)||(expectedProof!==undefined&&expectedProof!==csrfToken))throw stale()
   return {
    proof:csrfToken,
    async request<T=unknown>(path:string,method='GET',body?:unknown){
     const result=await perform<T>(path,method,body,stamp,csrfToken)
     // A rotated cookie can arrive in another tab before its page navigates.
     const current=await perform<{csrfToken:string}>('/api/v1/auth/session-proof','GET',undefined,stamp)
     if(current.csrfToken!==csrfToken)throw stale()
     return result
    },
   }
  },
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
    passwordAction=status!==undefined&&status>=400&&status<500?'idle':'unknown'
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
   finally{csrf=undefined;authTransition=false}
  },
  async homeRequest(path:string,method='GET',body?:unknown):Promise<unknown>{
   if(path==='/preferences')return request('/api/v1/preferences',method,body)
   if(path!=='/files'||method!=='GET')throw new Error('Unsupported local Home operation')
   const files:WebFile[]=[];const seen=new Set<string>();let cursor:string|null=null
   do{const page:{files:WebFile[];nextCursor:string|null}=await request<{files:WebFile[];nextCursor:string|null}>(`/api/v1/files?limit=100${cursor?'&cursor='+encodeURIComponent(cursor):''}`);files.push(...page.files);cursor=page.nextCursor;if(cursor){if(seen.has(cursor))throw new Error('Invalid file pagination');seen.add(cursor)}}while(cursor)
   return files
  },
  async upload(file:File){
   if(file.size>32*1024*1024)throw new Error('文件超过 32 MiB 限制')
   const stage=await request<{uploadId:string}>('/api/v1/files/uploads','POST',{name:file.name,size:file.size})
   await request(`/api/v1/uploads/${encodeURIComponent(stage.uploadId)}/content`,'PUT',file)
   // A failed finish may have committed: never retry or cancel it automatically.
   return request<{file:{fileId:string};format:string}>(`/api/v1/uploads/${encodeURIComponent(stage.uploadId)}/finish`,'POST')
  },
 }
}
