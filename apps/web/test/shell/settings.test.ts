import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {SettingsModal,type WebSettingsPreferences} from '../../../shell/src/renderer/src/SettingsModal'
import {LocaleProvider} from '../../../shell/src/renderer/src/locale'

test('original settings uses only Web capabilities and does not fake a failed preference save',async()=>{
 HTMLElement.prototype.scrollIntoView=vi.fn()
 const forbidden:string[]=[]
 window.aiOffice=new Proxy({},{get(_t,key){forbidden.push(String(key));throw new Error('desktop method called')}}) as typeof window.aiOffice
 document.body.innerHTML='<div id="settings-test"></div>'
 let persisted:WebSettingsPreferences={theme:'light',language:'zh',authorName:'Real author',autoSave:undefined as unknown as boolean,showAssistant:true}
 let fail=false
 const root=createRoot(document.querySelector('#settings-test')!)
 const render=()=>root.render(h(LocaleProvider,{initial:'zh',children:h(SettingsModal,{status:null,loggingOut:false,loginWaiting:false,loginUrl:null,urlCopied:false,onOpenLoginUrl(){},onCopyLoginUrl(){},onLogin(){},onLogout(){},onClose(){},web:{accountLabel:'本地账号',account:h('p',null,'个人开发访问令牌'),load:async()=>({...persisted}),save:async patch=>{if(fail)throw new Error('write rejected');persisted={...persisted,...patch};return {...persisted}}}})}))
 render()
 await vi.waitFor(()=>expect(document.querySelector('.set-dialog')).not.toBeNull())
 expect(document.querySelector('.set-nav-account-email')?.textContent).toBe('本地账号')
 ;([...document.querySelectorAll<HTMLButtonElement>('.set-nav-item')].find(b=>b.textContent==='通用')!).click()
 await vi.waitFor(()=>expect((document.querySelector('#set-author-name') as HTMLInputElement)?.value).toBe('Real author'))
 const auto=()=>document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="所有文档自动保存"]')!
 expect(auto()).not.toBeNull()
 expect(auto().getAttribute('aria-checked')).toBe('false')
 auto().click()
 await vi.waitFor(()=>expect(auto().getAttribute('aria-checked')).toBe('true'))
 expect(persisted.autoSave).toBe(true)
 fail=true;auto().click()
 await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toBe('write rejected'))
 expect(auto().getAttribute('aria-checked')).toBe('true')
 expect(persisted.autoSave).toBe(true)
 expect(document.querySelectorAll('.set-web-unavailable').length).toBe(4)
 expect(document.querySelectorAll('.set-nav-item:disabled').length).toBeGreaterThan(0)
 expect(forbidden).toEqual([])
 root.unmount()
})

test('Web preference saves fence same-turn clicks and cannot change theme after unmount',async()=>{
 HTMLElement.prototype.scrollIntoView=vi.fn()
 document.documentElement.dataset.theme='light'
 document.body.innerHTML='<div id="settings-race"></div>'
 const prefs:WebSettingsPreferences={theme:'light',language:'zh',authorName:'',autoSave:false,showAssistant:true}
 let writes=0;let finish:(value:WebSettingsPreferences)=>void=()=>{}
 const root=createRoot(document.querySelector('#settings-race')!)
 root.render(h(LocaleProvider,{initial:'zh',children:h(SettingsModal,{status:null,loggingOut:false,loginWaiting:false,loginUrl:null,urlCopied:false,onOpenLoginUrl(){},onCopyLoginUrl(){},onLogin(){},onLogout(){},onClose(){},web:{account:h('p',null,'Account'),load:async()=>prefs,save:async()=>{writes++;return new Promise(resolve=>{finish=resolve})}}})}))
 await vi.waitFor(()=>expect(document.querySelector('.set-dialog')).not.toBeNull())
 ;([...document.querySelectorAll<HTMLButtonElement>('.set-nav-item')].find(b=>b.textContent==='通用')!).click()
 await vi.waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="所有文档自动保存"]')?.disabled).toBe(false))
 const toggle=document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="所有文档自动保存"]')!
 toggle.click();toggle.click()
 expect(writes).toBe(1)
 finish({...prefs,autoSave:true})
 await vi.waitFor(()=>expect(toggle.getAttribute('aria-checked')).toBe('true'))
 document.querySelector<HTMLButtonElement>('[aria-label="主题"]')!.click()
 await vi.waitFor(()=>expect(document.querySelector('[role="option"][aria-label="深色"]')).not.toBeNull())
 document.querySelector<HTMLButtonElement>('[role="option"][aria-label="深色"]')!.click()
 await vi.waitFor(()=>expect(writes).toBe(2))
 root.unmount();finish({...prefs,theme:'dark'})
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(document.documentElement.dataset.theme).toBe('light')
})

