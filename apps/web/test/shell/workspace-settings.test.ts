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

test('successful password rotation reloads current sessions without losing the password success message',async()=>{
 const {act}=await import('react')
 const {localSessionsClient}=await import('../../src/shell/local-sessions-client')
 const {loginHistoryClient}=await import('../../src/shell/local-login-history-client')
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 let rotated=false
 const session=(id:string)=>({id,current:true,createdAt:'2026-01-01T00:00:00Z',lastSeenAt:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z'})
 const list=vi.spyOn(localSessionsClient,'list').mockImplementation(async()=>[session(rotated?'replacement-session':'old-session')])
 const history=vi.spyOn(loginHistoryClient,'list').mockResolvedValue([])
 document.body.innerHTML='<div id="rotation-test"></div>'
 const root=createRoot(document.getElementById('rotation-test')!)
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save:async()=>initial,security:{changePassword:async()=>{rotated=true},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{}})))
  expect(document.querySelector('[data-session-id="old-session"]')).not.toBeNull()
  const current=document.querySelector<HTMLInputElement>('#local-current-password')!,next=document.querySelector<HTMLInputElement>('#local-new-password')!,confirm=document.querySelector<HTMLInputElement>('#local-confirm-password')!
  current.value='existing long password';next.value=confirm.value='new long password phrase'
  await act(async()=>current.form!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(list).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[data-session-id="replacement-session"]')).not.toBeNull()
  expect(document.querySelector('[data-session-id="old-session"]')).toBeNull()
  expect(document.querySelector('.personal-account-password [role="status"]')?.textContent).toContain('当前会话已更新')
 }finally{await act(async()=>root.unmount());list.mockRestore();history.mockRestore();document.body.innerHTML=''}
})
