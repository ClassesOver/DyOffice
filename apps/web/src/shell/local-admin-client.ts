/** Local account API only. Never persists passwords, one-time codes or CSRF. */
export type LocalManagedUser={id:string;username:string;displayName:string;status:string;roles:string[];requiresPasswordReset:boolean}
export type PasswordAction={token:string;purpose:'activate'|'reset';expiresAt:string}
export function createLocalAdminClient(send:typeof fetch=fetch,onSessionExpired?:()=>void){
 let unknownWrite=false,pendingWrite=false,writeVersion=0
 async function mutate<T>(work:(started:()=>void)=>Promise<T>):Promise<T>{
  if(unknownWrite)throw Error('上次用户操作结果未确认，请先刷新列表核对。')
  if(pendingWrite)throw Error('用户操作正在处理中，请完成后重试。')
  pendingWrite=true;writeVersion++
  let started=false
  try{return await work(()=>{started=true})}catch(error){const status=(error as {status?:number})?.status;if(started&&(status===undefined||status>=500||status===408))unknownWrite=true;throw error}finally{pendingWrite=false}
 }
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 const invalid=()=>new Error('服务器响应无法确认，请刷新状态；不要重复提交不确定的操作')
 function user(value:unknown):LocalManagedUser{
  const u=value as LocalManagedUser
  if(!u||typeof u.id!=='string'||!uuid.test(u.id)||typeof u.username!=='string'||typeof u.displayName!=='string'||!['pending','active','disabled'].includes(u.status)||typeof u.requiresPasswordReset!=='boolean'||!Array.isArray(u.roles)||u.roles.some(r=>!['personal','config_admin','operator','auditor'].includes(r)))throw invalid()
  return u
 }
 function action(value:unknown,purpose:'activate'|'reset'):PasswordAction{
  const a=value as PasswordAction
  if(!a||typeof a.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(a.token)||a.purpose!==purpose||typeof a.expiresAt!=='string'||!Number.isFinite(Date.parse(a.expiresAt)))throw invalid()
  return a
 }
 async function request<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST',noContent=false,started?:()=>void):Promise<T>{
  let csrf:string|undefined
  if(method!=='GET'){const result=await request<{csrfToken:string}>('/api/v1/auth/csrf');csrf=result.csrfToken;if(typeof csrf!=='string'||!csrf)throw new Error('安全校验不可用，请重新登录')}
  started?.()
  const response=await send(path,{method,credentials:'same-origin',redirect:'error',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf!},body:body===undefined?undefined:JSON.stringify(body)})
  if(response.status===401&&onSessionExpired){
   if(path==='/api/v1/auth/reauth'){try{const identity=await send('/api/v1/auth/me',{credentials:'same-origin',cache:'no-store',redirect:'error'});if(identity.status===401)onSessionExpired()}catch{}}
   else onSessionExpired()
  }
  if(!response.ok)throw Object.assign(new Error(response.status===401?'会话已过期，请重新登录':response.status===403?'无权限或需要重新验证管理员密码':response.status===409?'操作冲突，请刷新用户状态后确认':response.status===429?'请求过于频繁，请稍后再试':'操作未完成，请检查输入；不要重复提交不确定的操作'),{status:response.status})
  if(noContent&&response.status!==204)throw invalid()
  return (response.status===204?undefined:await response.json()) as T
 }
 const id=(value:string)=>{if(!uuid.test(value))throw new Error('无效用户标识');return value}
 return {
  getState(){return {unknownWrite,pendingWrite}},
  async list(after?:string){const version=writeVersion,reconcile=unknownWrite;const page=await request<{users:unknown[];nextCursor:string|null}>('/api/v1/admin/users?limit=20'+(after?'&after='+id(after):''));if(!page||!Array.isArray(page.users)||(page.nextCursor!==null&&(typeof page.nextCursor!=='string'||!uuid.test(page.nextCursor))))throw invalid();const users=page.users.map(user);if(reconcile&&version===writeVersion&&!pendingWrite)unknownWrite=false;return {users,nextCursor:page.nextCursor}},
  async reauthenticate(password:string){const result=await request<{csrfToken:string}>('/api/v1/auth/reauth',{password});if(typeof result?.csrfToken!=='string'||!result.csrfToken)throw invalid();return result.csrfToken},
  async create(username:string,displayName:string){return mutate(async started=>{const result=await request<{user:unknown;action:unknown}>('/api/v1/admin/users',{username,displayName},'POST',false,started);return {user:user(result?.user),action:action(result?.action,'activate')}})},
  async issue(userId:string,purpose:'activate'|'reset'){if(!['activate','reset'].includes(purpose))throw new Error('无效用途');const path=`/api/v1/admin/users/${id(userId)}/${purpose==='activate'?'activation':'password-reset'}`;return mutate(async started=>{const result=await request<{action:unknown}>(path,{},'POST',false,started);return {action:action(result?.action,purpose)}})},
  async setStatus(userId:string,status:'active'|'disabled'){if(!['active','disabled'].includes(status))throw new Error('无效状态');const path=`/api/v1/admin/users/${id(userId)}`;return mutate(async started=>{const result=await request<{user:unknown}>(path,{status},'PATCH',false,started);return {user:user(result?.user)}})},
  async setRoles(userId:string,roles:string[]){if(!roles.length||roles.length>4||new Set(roles).size!==roles.length||roles.some(r=>!['personal','config_admin','operator','auditor'].includes(r)))throw new Error('无效角色');const path=`/api/v1/admin/users/${id(userId)}`;return mutate(async started=>{const result=await request<{user:unknown}>(path,{roles},'PATCH',false,started);return {user:user(result?.user)}})},
  async redeem(token:string,purpose:'activate'|'reset',password:string){if(!/^[A-Za-z0-9_-]{43}$/.test(token)||!['activate','reset'].includes(purpose))throw new Error('无效一次性码');await request('/api/v1/auth/password-action',{token,purpose,password},'POST',true)},
 }
}
export type LocalAdminClient=ReturnType<typeof createLocalAdminClient>
