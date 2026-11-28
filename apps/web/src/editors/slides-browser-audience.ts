import type {AudienceNavAction,ShowInkEvent,ShowSyncState} from '../../../slides/src/shared/ipc'

/** Keep the audience in the editor's React tree and current, possibly unsaved deck session. */
export function createBrowserAudience(stage:Window,title:string,onChange:()=>void){
 let popup:Window|null=null
 let sync:ShowSyncState|null=null
 const stateListeners=new Set<(state:ShowSyncState)=>void>()
 const inkListeners=new Set<(event:ShowInkEvent)=>void>()
 const navigationListeners=new Set<(action:AudienceNavAction)=>void>()
 const subscribe=<T>(listeners:Set<(value:T)=>void>,listener:(value:T)=>void)=>{
  listeners.add(listener)
  return ()=>{listeners.delete(listener)}
 }
 const current=()=>popup&&!popup.closed?popup:null
 function open(){
  const existing=current()
  if(existing){existing.focus();return true}
  const opened=stage.open('about:blank','_blank','popup')
  if(!opened)return false
  try{
   opened.opener=null
   const doc=opened.document
   doc.title=title
   doc.documentElement.lang=stage.document.documentElement.lang
   // The blank audience document inherits the editor origin, but fetching
   // protected stylesheets again from it may omit the editor's session cookie.
   const style=doc.createElement('style')
   style.textContent=[...stage.document.styleSheets]
    .map(sheet=>[...sheet.cssRules].map(rule=>rule.cssText).join('\n')).join('\n')
   doc.head.append(style)
   const copyFontFaces=()=>{
    doc.fonts.clear()
    for(const face of stage.document.fonts)if(face.status==='loaded')doc.fonts.add(face)
   }
   copyFontFaces()
   stage.document.fonts.addEventListener('loadingdone',copyFontFaces)
   opened.addEventListener('pagehide',()=>{
    stage.document.fonts.removeEventListener('loadingdone',copyFontFaces)
    if(popup!==opened)return
    popup=null
    onChange()
   },{once:true})
   popup=opened
   onChange()
   return true
  }catch{opened.close();return false}
 }
 function end(){
  sync=null
  if(!popup)return
  const opened=popup
  popup=null
  opened.close()
  onChange()
 }
 return {open,end,current,api:{
  audienceReady:async()=>sync,
  audienceNav:(action:AudienceNavAction)=>{for(const listener of navigationListeners)listener(action)},
  presenterSync:(state:ShowSyncState)=>{
   sync=state
   for(const listener of stateListeners)listener(state)
  },
  presenterInk:(event:ShowInkEvent)=>{for(const listener of inkListeners)listener(event)},
  onShowSync:(listener:(state:ShowSyncState)=>void)=>subscribe(stateListeners,listener),
  onShowInk:(listener:(event:ShowInkEvent)=>void)=>subscribe(inkListeners,listener),
  onAudienceNav:(listener:(action:AudienceNavAction)=>void)=>subscribe(navigationListeners,listener),
 }}
}
