import type {PublicSettings} from '../../../../packages/web-contracts/src/api'

type AutosavePreference=Pick<PublicSettings,'autoSave'|'autoSaveUpdatedAt'>
const attribute='data-web-autosave-default'

function readAutosaveDefault(root:HTMLElement|undefined){
 const value=root?.getAttribute(attribute)
 const match=value&&/^([01]):(\d+)$/.exec(value)
 if(!match)return
 const updatedAt=Number(match[2])
 if(Number.isSafeInteger(updatedAt)&&updatedAt>=1)return {on:match[1]==='1',updatedAt}
}

export function publishBrowserAutoSaveDefault(root:HTMLElement,prefs:AutosavePreference){
 if(prefs.autoSave===undefined)return
 const updatedAt=prefs.autoSaveUpdatedAt??1
 if(updatedAt<(readAutosaveDefault(root)?.updatedAt??1))return
 root.setAttribute(attribute,`${prefs.autoSave?'1':'0'}:${updatedAt}`)
}

export function browserAutoSaveDefault(prefs:AutosavePreference,fallbackOn=false){
 const root=typeof document==='undefined'?undefined:document.documentElement
 const fallback={on:prefs.autoSave??fallbackOn,updatedAt:prefs.autoSaveUpdatedAt??1}
 const read=()=>{
  const current=readAutosaveDefault(root)
  return current&&current.updatedAt>=fallback.updatedAt?current:fallback
 }
 return {
  getAutoSaveDefault:async()=>read(),
  onAutoSaveDefaultChanged(handler:(value:ReturnType<typeof read>)=>void){
   if(!root||typeof MutationObserver==='undefined')return ()=>{}
   let last=read()
   const observer=new MutationObserver(()=>{
    const next=read()
    if(next.on===last.on&&next.updatedAt===last.updatedAt)return
    last=next
    handler(next)
   })
   observer.observe(root,{attributeFilter:[attribute]})
   return ()=>observer.disconnect()
  },
 }
}
