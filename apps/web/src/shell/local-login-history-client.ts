export type LoginHistoryEvent={occurredAt:string;outcome:'success'|'failure'|'throttled'}
export function createLoginHistoryClient(send:typeof fetch=fetch,onSessionExpired?:()=>void){return {
 async listPage({limit=20,after}:{limit?:number;after?:string}={}):Promise<{events:LoginHistoryEvent[];nextCursor:string|null}>{
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const invalid=()=>new Error('无法确认登录历史响应，请稍后刷新。')
  if(!Number.isInteger(limit)||limit<1||limit>20||(after!==undefined&&!uuid.test(after)))throw invalid()
  const params=new URLSearchParams({limit:String(limit)});if(after)params.set('after',after)
  const response=await send('/api/v1/auth/login-history?'+params,{credentials:'same-origin',cache:'no-store',redirect:'error'})
  if(response.status===401)onSessionExpired?.()
  if(!response.ok)throw new Error(response.status===401?'会话已失效，请重新登录。':'登录历史暂不可用，请稍后刷新。')
  const data=await response.json()
  if(!data||!Array.isArray(data.events)||data.events.length>limit||(data.nextCursor!==null&&(typeof data.nextCursor!=='string'||!uuid.test(data.nextCursor)))||(data.nextCursor!==null&&data.events.length!==limit))throw invalid()
  const events=data.events.map((event:LoginHistoryEvent)=>{if(!event||typeof event.occurredAt!=='string'||event.occurredAt.length>40||!Number.isFinite(Date.parse(event.occurredAt))||!['success','failure','throttled'].includes(event.outcome))throw invalid();return {occurredAt:event.occurredAt,outcome:event.outcome}})
  return {events,nextCursor:data.nextCursor}
 },
 async list():Promise<LoginHistoryEvent[]>{
  const response=await send('/api/v1/auth/login-history',{credentials:'same-origin',cache:'no-store',redirect:'error'})
  if(response.status===401)onSessionExpired?.()
  if(!response.ok)throw new Error(response.status===401?'会话已失效，请重新登录。':'登录历史暂不可用，请稍后刷新。')
  const data=await response.json()
  const invalid=()=>new Error('无法确认登录历史响应，请稍后刷新。')
  if(!data||!Array.isArray(data.events)||data.events.length>20)throw invalid()
  return data.events.map((event:LoginHistoryEvent)=>{if(!event||typeof event.occurredAt!=='string'||event.occurredAt.length>40||!Number.isFinite(Date.parse(event.occurredAt))||!['success','failure','throttled'].includes(event.outcome))throw invalid();return {occurredAt:event.occurredAt,outcome:event.outcome}})
 },
}}
export type LoginHistoryClient=ReturnType<typeof createLoginHistoryClient>
export const loginHistoryClient=createLoginHistoryClient()
