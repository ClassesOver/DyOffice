import {createGlobalSettingsClient,type GlobalSettingsRequest} from './global-settings-client'
import type {createLocalShellClient} from './local-client'
type LocalClient=ReturnType<typeof createLocalShellClient>
type BoundSession=Awaited<ReturnType<LocalClient['bindSession']>>
const stale=()=>Object.assign(new Error('登录状态已改变，请重新加载当前工作区。'),{code:'stale_session'})
/** Preserve the operation/unknown fence across verified same-user rotation. */
export function createLocalGlobalSettingsSession(client:LocalClient){
 let binding:BoundSession|undefined,version=0
 client.onSessionEnded(()=>{binding=undefined;version++})
 const request:GlobalSettingsRequest=async<T>(path:string,method='GET',body?:unknown):Promise<T>=>{
  const current=binding,stamp=version
  if(!current)throw stale()
  const obsolete=()=>stamp!==version||binding!==current
  // A late write may have committed under the old, valid session. Preserve an
  // unknown write rather than treating replacement of the view as a rejection.
  const superseded=()=>method==='GET'||method==='HEAD'?stale():new Error('会话已更新，上次配置写入结果尚未确认，请重新读取后核对。')
  try{
   const result=await current.request<T>(path,method,body)
   if(obsolete())throw superseded()
   return result
  }catch(error){
   if(obsolete())throw superseded()
   const failure=error as {status?:number;code?:string}
   if(failure.code==='stale_session')client.endSession('expired')
   else if(failure.status===403){
    // Permission denial alone does not mean account rotation. Verify the old
    // proof, without refreshing/replaying the rejected configuration mutation.
    try{await client.bindSession(current.proof)}
    catch(cause){
     if(!obsolete()&&(cause as {code?:string}).code==='stale_session'){
      client.endSession('expired')
      throw Object.assign(stale(),{status:403})
     }
    }
   }
   throw error
  }
 }
 return {settings:createGlobalSettingsClient(request),bind(session:BoundSession){binding=session;version++}}
}
