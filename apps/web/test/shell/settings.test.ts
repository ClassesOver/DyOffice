import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {SettingsModal,type WebSettingsPreferences} from '../../../shell/src/renderer/src/SettingsModal'
import {LocaleProvider} from '../../../shell/src/renderer/src/locale'

const initial:WebSettingsPreferences={theme:'light',language:'zh',authorName:'Original',autoSave:false,showAssistant:true}
async function fixture(){
 HTMLElement.prototype.scrollIntoView=vi.fn();document.body.innerHTML='<div id="settings-test"></div>'
 const forbidden:string[]=[];window.aiOffice=new Proxy({},{get(_t,key){forbidden.push(String(key));throw Error('desktop method called')}}) as typeof window.aiOffice
 let persisted={...initial},fail=false,hold=false,finish:()=>void=()=>{};const writes:Partial<WebSettingsPreferences>[]=[];const closed=vi.fn()
 const root=createRoot(document.querySelector('#settings-test')!)
 root.render(h(LocaleProvider,{initial:'zh',children:h(SettingsModal,{status:null,loggingOut:false,loginWaiting:false,loginUrl:null,urlCopied:false,onOpenLoginUrl(){},onCopyLoginUrl(){},onLogin(){},onLogout(){},onClose:closed,web:{account:h('p',null,'Account'),load:async()=>({...persisted}),save:async patch=>{writes.push({...patch});if(hold)await new Promise<void>(r=>finish=r);if(fail)throw Error('write rejected');persisted={...persisted,...patch};return {...persisted}}}})}))
 await vi.waitFor(()=>expect(document.querySelector('.set-dialog')).not.toBeNull())
 ;([...document.querySelectorAll<HTMLButtonElement>('.set-nav-item')].find(b=>b.textContent==='通用')!).click()
 await vi.waitFor(()=>expect((document.querySelector('#set-author-name') as HTMLInputElement)?.value).toBe('Original'))
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!
 const author=()=>document.querySelector<HTMLInputElement>('#set-author-name')!
 const toggle=()=>document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="所有文档自动保存"]')!
 const edit=(text:string)=>flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(author(),text);author().dispatchEvent(new Event('input',{bubbles:true}))})
 return {root,button,author,toggle,edit,writes,closed,forbidden,persisted:()=>persisted,fail:()=>fail=true,recover:()=>fail=false,hold:()=>hold=true,finish:()=>finish()}
}
test('blur then immediate toggle keeps both drafts until explicit atomic save',async()=>{
 const f=await fixture();try{
 f.edit('Draft author');f.author().dispatchEvent(new FocusEvent('focusout',{bubbles:true}));flushSync(()=>f.toggle().click())
 expect(f.writes).toHaveLength(0);expect(f.author().value).toBe('Draft author');expect(f.toggle().getAttribute('aria-checked')).toBe('true')
 expect(f.button('保存个人偏好')).toBeTruthy();f.button('保存个人偏好').click()
 await vi.waitFor(()=>expect(f.persisted()).toMatchObject({authorName:'Draft author',autoSave:true}))
 expect(f.writes).toEqual([{authorName:'Draft author',autoSave:true}]);expect(f.forbidden).toEqual([])
 }finally{f.root.unmount()}
})
test('rapid same-turn toggles use latest draft and failed saves retain draft without replay',async()=>{
 const f=await fixture();try{
 flushSync(()=>{f.toggle().click();f.toggle().click();f.toggle().click()});expect(f.toggle().getAttribute('aria-checked')).toBe('true')
 f.edit('Not lost');f.fail();f.button('保存个人偏好').click()
 await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toBe('write rejected'))
 expect(f.author().value).toBe('Not lost');expect(f.toggle().getAttribute('aria-checked')).toBe('true');expect(f.persisted()).toEqual(initial);expect(f.writes).toHaveLength(1)
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 document.querySelector<HTMLButtonElement>('.set-close')!.click();expect(f.closed).not.toHaveBeenCalled();expect(confirm).toHaveBeenCalled();confirm.mockRestore()
 }finally{f.root.unmount()}
})
test('explicit save fences double submission and late response cannot change theme after unmount',async()=>{
 const f=await fixture();try{
 document.documentElement.dataset.theme='light';document.querySelector<HTMLButtonElement>('[aria-label="主题"]')!.click()
 await vi.waitFor(()=>expect(document.querySelector('[role="option"][aria-label="深色"]')).not.toBeNull())
 flushSync(()=>document.querySelector<HTMLButtonElement>('[role="option"][aria-label="深色"]')!.click())
 f.hold();f.button('保存个人偏好').click();f.button('保存个人偏好').click();expect(f.writes).toHaveLength(1)
 f.root.unmount();f.finish();await new Promise(r=>setTimeout(r,0));expect(document.documentElement.dataset.theme).toBe('light')
 }finally{f.root.unmount()}
})

test('language and author save together without separate locale writes; reload restores persisted values',async()=>{
 const f=await fixture();try{
 f.edit('Saved author');document.querySelector<HTMLButtonElement>('[aria-label="语言"]')!.click()
 await vi.waitFor(()=>expect(document.querySelector('[role="option"][aria-label="English"]')).not.toBeNull())
 flushSync(()=>document.querySelector<HTMLButtonElement>('[role="option"][aria-label="English"]')!.click())
 expect(f.writes).toHaveLength(0);f.author().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))
 await vi.waitFor(()=>expect(f.persisted()).toMatchObject({authorName:'Saved author',language:'en'}))
 expect(f.forbidden).toEqual([]);await vi.waitFor(()=>expect(document.querySelector('[role="status"]')?.textContent).toContain('刷新后生效'))
 f.edit('Discard me');const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 f.button('重新读取').click();expect(f.author().value).toBe('Discard me')
 confirm.mockReturnValue(true);f.button('重新读取').click()
 await vi.waitFor(()=>expect(f.author().value).toBe('Saved author'));confirm.mockRestore();expect(f.writes).toHaveLength(1)
 }finally{f.root.unmount()}
})
test('explicit failure allows explicit retry with all retained edits, without automatic replay',async()=>{
 const f=await fixture();try{
 f.edit('Retry author');flushSync(()=>f.toggle().click());f.fail();f.button('保存个人偏好').click()
 await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toBe('write rejected'))
 expect(f.writes).toHaveLength(1);f.recover();f.button('保存个人偏好').click()
 await vi.waitFor(()=>expect(f.persisted()).toMatchObject({authorName:'Retry author',autoSave:true}));expect(f.writes).toHaveLength(2)
 document.querySelector<HTMLButtonElement>('.set-close')!.click();expect(f.closed).toHaveBeenCalledOnce()
 }finally{f.root.unmount()}
})

test('unsaved drafts guard browser unload and cancelled close keeps the form',async()=>{
 const f=await fixture();try{
 f.edit('Keep on this page')
 const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true)
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));expect(f.closed).not.toHaveBeenCalled();expect(f.author().value).toBe('Keep on this page');confirm.mockRestore()
 }finally{f.root.unmount()}
})
