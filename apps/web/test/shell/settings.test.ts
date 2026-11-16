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
 const render=()=>root.render(h(LocaleProvider,{initial:'zh',children:h(SettingsModal,{status:null,loggingOut:false,loginWaiting:false,loginUrl:null,urlCopied:false,onOpenLoginUrl(){},onCopyLoginUrl(){},onLogin(){},onLogout(){},onClose(){},web:{account:h('p',null,'个人开发访问令牌'),load:async()=>({...persisted}),save:async patch=>{if(fail)throw new Error('write rejected');persisted={...persisted,...patch};return {...persisted}}}})}))
 render()
 await vi.waitFor(()=>expect(document.querySelector('.set-dialog')).not.toBeNull())
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
