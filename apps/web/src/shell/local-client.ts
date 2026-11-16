import type {WebFile} from './web-home-bridge'
/** Local mode only: HttpOnly session cookies, ephemeral CSRF, no bearer/JSON fallback. */
export function createLocalShellClient(send:typeof fetch=fetch) {
 let csrf:string|undefined
 let passwordAction:'idle'|'pending'|'unknown'='idle'
 async function request<T=unknown>(path:string,method='GET',body?:unknown):Promise<T>{
  if(!path.startsWith('/api/v1/')||path.includes('\\')||path.includes('#'))throw new Error('Expected same-origin local API path')
  const write=!['GET','HEAD'].includes(method)
  if(write&&!csrf){const result=await request<{csrfToken:string}>('/api/v1/auth/csrf');csrf=result.csrfToken}
  const binary=body instanceof Blob
  const response=await send(path,{method,credentials:'same-origin',cache:'no-store',headers:{...(write?{'X-CSRF-Token':csrf!}:{}),...(body!==undefined?{'Content-Type':binary?'application/octet-stream':'application/json'}:{})},body:body===undefined?undefined:binary?body:JSON.stringify(body)})
  const value=response.status===204?undefined:await response.json()
  if(!response.ok){if(response.status===401||response.status===403)csrf=undefined;throw Object.assign(new Error(value?.message||value?.title||'请求失败'),{status:response.status})}
  return value as T
 }
 return {
  request,
  invalidateCsrf(){csrf=undefined},
  async changePassword(currentPassword:string,newPassword:string){
   if(passwordAction!=='idle')throw new Error(passwordAction==='pending'?'密码修改正在进行中。':'无法确认上次密码修改结果，请重新加载。')
   passwordAction='pending'
   try{
    const result=await request<{csrfToken:string}>('/api/v1/auth/change-password','POST',{currentPassword,newPassword})
    if(!result||typeof result.csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.csrfToken))throw new Error('无法确认密码修改结果。')
    csrf=result.csrfToken;passwordAction='idle'
   }catch(error){
    csrf=undefined
    const status=(error as {status?:number})?.status
    passwordAction=status!==undefined&&status>=400&&status<500?'idle':'unknown'
    throw error
   }
  },
  async login(username:string,password:string){csrf=undefined;try{const result=await request<{user:{id:string;username:string;displayName:string;roles:string[]};csrfToken:string}>('/api/v1/auth/login','POST',{username,password});csrf=result.csrfToken;return result.user}finally{csrf=undefined}},
  async logout(){await request('/api/v1/auth/logout','POST');csrf=undefined},
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
