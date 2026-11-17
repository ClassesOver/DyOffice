import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from '../../src/shell/WorkspaceSettings'
const initial={theme:'light' as const,language:'zh' as const,authorName:'Original',autoSave:false,showAssistant:true}
test('preferences remain drafts until explicit save and pending save prevents tab closure',async()=>{
 document.body.innerHTML='<div id="test"></div>'
 const root=createRoot(document.getElementById('test')!)
 let guard:(()=>boolean)|null=null,finish:(v:typeof initial)=>void=()=>{}
 const save=vi.fn(()=>new Promise<typeof initial>(resolve=>{finish=resolve}))
 root.render(h(WorkspaceSettings,{user:{username:'admin',displayName:'Admin',roles:['personal']},load:async()=>initial,save,security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:g=>{guard=g}}))
 try{
 await vi.waitFor(()=>expect([...document.querySelectorAll('[role=tab]')].some(t=>t.textContent==='通用偏好')).toBe(true))
 ;([...document.querySelectorAll<HTMLElement>('[role=tab]')].find(t=>t.textContent==='通用偏好')!).click()
 await vi.waitFor(()=>expect(document.querySelector('[aria-label="自动保存"]')).not.toBeNull())
 ;(document.querySelector('[aria-label="自动保存"]') as HTMLButtonElement).click()
 await vi.waitFor(()=>expect((document.querySelector('[aria-label="自动保存"]') as HTMLElement).getAttribute('aria-checked')).toBe('true'))
 expect(save).not.toHaveBeenCalled()
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);expect(guard?.()).toBe(false);confirm.mockRestore()
 const submit=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='保存个人偏好')!;submit.click()
 await vi.waitFor(()=>expect(save).toHaveBeenCalledWith({autoSave:true}));expect(guard?.()).toBe(false)
 finish({...initial,autoSave:true})
 await vi.waitFor(()=>expect(document.body.textContent).toContain('个人偏好已保存'));expect(guard?.()).toBe(true)
 }finally{root.unmount()}
})
