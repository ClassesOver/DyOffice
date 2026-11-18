import {createLocalShellClient} from '../shell/local-client'
export type DraftCopyAuthority={current():boolean;verify():Promise<boolean>}
export type DraftCopyFrame=HTMLIFrameElement&{dyofficeDraftCopySessionActive?:()=>boolean}
/** Only same-origin embedding with an explicit live Shell grant is accepted. */
export function draftCopyParentActive(stage:Window){
 try{
  if(stage.parent===stage)return true
  const frame=stage.frameElement as DraftCopyFrame|null
  return !!frame?.isConnected&&frame.ownerDocument.defaultView===stage.parent&&frame.dyofficeDraftCopySessionActive?.()===true
 }catch{return false}
}
/** Capture before opening document bytes; never adopt a later account's proof. */
export async function createDraftCopyAuthority(active:()=>boolean,send:typeof fetch=fetch):Promise<DraftCopyAuthority>{
 let valid=true
 const current=()=>{try{if(!active())valid=false}catch{valid=false}return valid}
 const client=createLocalShellClient(send)
 try{
  if(!current())throw Error('inactive')
  const original=await client.bindSession()
  if(!current())throw Error('inactive')
  return {current,async verify(){
   if(!current())return false
   try{await client.bindSession(original.proof);return current()}
   catch{valid=false;return false}
  }}
 }catch{valid=false;return {current,verify:async()=>false}}
}
