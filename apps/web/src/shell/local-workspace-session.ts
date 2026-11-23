import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {createLocalShellClient} from './local-client'
type Client=ReturnType<typeof createLocalShellClient>
type Bound=Awaited<ReturnType<Client['bindSession']>>
const stale=()=>Object.assign(new Error('登录状态已改变，请重新加载当前工作区。'),{code:'stale_session'})

/** Stable clients retain their pending/unknown operations across verified same-user rotation. */
export function createLocalWorkspaceSession(client:Client){
 let binding:Bound|undefined,version=0
 client.onSessionEnded(()=>{binding=undefined;version++})
 const request:SettingsRequest=async<T>(path:string,method='GET',body?:unknown):Promise<T>=>{
  const current=binding,stamp=version
  if(!current)throw stale()
  const obsolete=()=>binding!==current||version!==stamp
  // Never turn a possibly committed write into a definite rejection after rebinding.
  const changed=()=>['GET','HEAD'].includes(method)?stale():new Error('会话已更新，操作结果尚未确认。请核对后再操作，不要重复提交。')
  try{
   const result=await current.request<T>(path,method,body)
   if(obsolete())throw changed()
   return result
  }catch(error){
   if(obsolete())throw changed()
   const failure=error as {code?:string;status?:number}
   if(failure.code==='stale_session')client.endSession('expired')
   else if(failure.status===403){
    try{await client.bindSession(current.proof)}
    catch(cause){if(!obsolete()&&(cause as {code?:string}).code==='stale_session')client.endSession('expired')}
   }
   throw error
  }
 }
 // Compatibility with the bodyless session-management client. The captured
 // bound request, not a caller's/fresh cookie's CSRF header, authorizes each call.
 const sessionFetch:typeof fetch=async(input,init={})=>{
  if(typeof input!=='string'||!/^\/api\/v1\/auth\/(?:csrf|sessions(?:\/[0-9a-f-]+|\/revoke-others)?)(?:\?[^#]*)?$/.test(input)||init.body!==undefined||!['GET','POST','DELETE'].includes(init.method??'GET'))throw stale()
  if((init.method??'GET')!=='GET'&&new Headers(init.headers).get('x-csrf-token')!==binding?.proof)throw stale()
  try{
   const value=await request(input,init.method??'GET')
   return value===undefined?new Response(null,{status:204}):new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}})
  }catch(error){
   const status=(error as {status?:number}).status
   if(typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<=599)return new Response(null,{status})
   throw error
  }
 }
 return {request,sessionFetch,bind(session:Bound){binding=session;version++}}
}
