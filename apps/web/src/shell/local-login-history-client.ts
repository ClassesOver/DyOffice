export type LoginHistoryEvent={occurredAt:string;outcome:'success'|'failure'|'throttled'}
export function createLoginHistoryClient(send:typeof fetch=fetch){return {
 async list():Promise<LoginHistoryEvent[]>{
  const response=await send('/api/v1/auth/login-history',{credentials:'same-origin',cache:'no-store',redirect:'error'})
  if(!response.ok)throw new Error(response.status===401?'会话已失效，请重新登录。':'登录历史暂不可用，请稍后刷新。')
  const data=await response.json()
  const invalid=()=>new Error('无法确认登录历史响应，请稍后刷新。')
  if(!data||!Array.isArray(data.events)||data.events.length>20)throw invalid()
  return data.events.map((event:LoginHistoryEvent)=>{if(!event||typeof event.occurredAt!=='string'||event.occurredAt.length>40||!Number.isFinite(Date.parse(event.occurredAt))||!['success','failure','throttled'].includes(event.outcome))throw invalid();return {occurredAt:event.occurredAt,outcome:event.outcome}})
 },
}}
export type LoginHistoryClient=ReturnType<typeof createLoginHistoryClient>
export const loginHistoryClient=createLoginHistoryClient()
