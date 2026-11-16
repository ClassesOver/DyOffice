import {createAdminAiProbeController} from '../../../packages/browser-host/src/ai-probe.ts'
import {mountProviderProbe,bindProbeLifecycle} from './page.ts'
import './style.css'
const root=document.querySelector<HTMLElement>('main')!
const pending=new Set<AbortController>()
const client=createAdminAiProbeController({getCsrfToken:async()=>{
 const control=new AbortController();pending.add(control);const timer=setTimeout(()=>control.abort(),5000)
 try{const response=await fetch('/api/v1/auth/csrf',{credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:control.signal})
 if(!response.ok)throw Error('Session unavailable')
 const body=await response.json();if(typeof body.csrfToken!=='string')throw Error('Session unavailable');return body.csrfToken}finally{clearTimeout(timer);pending.delete(control)}
}})
const view=mountProviderProbe(root,client)
bindProbeLifecycle(window,()=>{for(const control of pending)control.abort();view.dispose()},()=>window.location.reload())
