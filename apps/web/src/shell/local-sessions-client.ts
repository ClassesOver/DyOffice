export type LocalSession={id:string;current:boolean;createdAt:string;lastSeenAt:string;expiresAt:string}
/** No cookies/tokens in JavaScript storage; read reconciliation precedes uncertain retry. */
export function createLocalSessionsClient(send:typeof fetch=fetch,onSessionExpired?:()=>void){
 const states=new Map<string,'pending'|'unknown'>()
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
 const invalid=()=>new Error('无法确认会话操作结果，请刷新列表后核对。')
 async function request(path:string,options:RequestInit={}){const response=await send(path,{...options,credentials:'same-origin',cache:'no-store',redirect:'error'});if(response.status===401)onSessionExpired?.();if(!response.ok)throw Object.assign(new Error(response.status===401?'会话已失效，请重新登录。':response.status===403?'请求被拒绝，请刷新登录状态。':'请求未完成，请刷新列表核对。'),{status:response.status});return response}
 function parseRows(data:unknown):LocalSession[]{
  const value=data as {sessions?:LocalSession[]}
  if(!value||!Array.isArray(value.sessions))throw invalid()
   const seen=new Set<string>()
   const rows=value.sessions.map((value:LocalSession)=>{if(!value||typeof value.id!=='string'||!uuid.test(value.id)||seen.has(value.id)||typeof value.current!=='boolean'||[value.createdAt,value.lastSeenAt,value.expiresAt].some(date=>typeof date!=='string'||!Number.isFinite(Date.parse(date))))throw invalid();seen.add(value.id);return {id:value.id,current:value.current,createdAt:value.createdAt,lastSeenAt:value.lastSeenAt,expiresAt:value.expiresAt}})
  return rows
 }
 async function mutate(key:string,path:string,method:string){
  if(states.has(key)||states.has('others')||(key==='others'&&states.size>0))throw new Error('操作进行中或结果未知，请刷新列表后核对。')
  states.set(key,'pending')
  try{
   const {csrfToken}=await (await request('/api/v1/auth/csrf')).json()
   if(typeof csrfToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(csrfToken))throw invalid()
   const response=await request(path,{method,headers:{'X-CSRF-Token':csrfToken}})
   if(response.status!==204)throw invalid()
   states.delete(key)
  }catch(error){const status=(error as {status?:number})?.status;if(status!==undefined&&status>=400&&status<500&&status!==408)states.delete(key);else states.set(key,'unknown');throw error}
 }
 return {
  async list():Promise<LocalSession[]>{
   const unknown=[...states].filter(([,state])=>state==='unknown').map(([id])=>id)
   const data=await (await request('/api/v1/auth/sessions')).json()
   if(!data||!Array.isArray(data.sessions))throw invalid()
   const rows=parseRows(data)
   for(const id of unknown)if(states.get(id)==='unknown')states.delete(id)
   return rows
  },
  async listPage({limit=20,after}:{limit?:number;after?:string}={}):Promise<{sessions:LocalSession[];nextCursor:string|null}>{
   if(!Number.isSafeInteger(limit)||limit<1||limit>100||(after!==undefined&&!uuid.test(after)))throw invalid()
   const query=new URLSearchParams({limit:String(limit)});if(after!==undefined)query.set('after',after)
   const data=await (await request('/api/v1/auth/sessions?'+query)).json()
   const rows=parseRows(data)
   if(rows.length>limit||(data.nextCursor!==null&&(typeof data.nextCursor!=='string'||!uuid.test(data.nextCursor)||rows.length!==limit||rows.at(-1)?.id!==data.nextCursor)))throw invalid()
   // A partial page cannot reconcile an uncertain revoke or revoke-others.
   // Only the explicit legacy full-list reconciliation may release that guard.
   return {sessions:rows,nextCursor:data.nextCursor}
  },
  async revoke(id:string){if(!uuid.test(id))throw new Error('无效会话标识。');return mutate(id,'/api/v1/auth/sessions/'+id,'DELETE')},
  revokeOthers:()=>mutate('others','/api/v1/auth/sessions/revoke-others','POST'),
 }
}
export type LocalSessionsClient=ReturnType<typeof createLocalSessionsClient>
// Survives Settings panel unmount/remount; holds no authentication secrets.
export const localSessionsClient=createLocalSessionsClient(async()=>{throw Object.assign(new Error('登录状态未核验，请重新加载当前工作区。'),{code:'stale_session'})})
