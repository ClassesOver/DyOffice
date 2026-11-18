import {test,expect,vi} from 'vitest'
import {createElement as h,act} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from '../../src/shell/WorkspaceSettings'
test('B navigation retains every personal section and preserves preference drafts across sections',async()=>{
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 document.body.innerHTML='<div id="b-test"></div>'
 const root=createRoot(document.getElementById('b-test')!)
 const save=vi.fn(),initial={theme:'light' as const,language:'zh' as const,authorName:'Original',autoSave:false,showAssistant:true}
 const tab=(name:string)=>[...document.querySelectorAll<HTMLElement>('[role=tab]')].find(t=>t.textContent===name)!
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save,sessionsClient:{listPage:async()=>({sessions:[],nextCursor:null}),list:async()=>[],revoke:async()=>{},revokeOthers:async()=>{}},historyClient:{list:async()=>[],listPage:async()=>({events:[],nextCursor:null})},security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'个人技能列表'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{}})))
  expect(document.querySelector('[role=tablist]')?.getAttribute('aria-orientation')).toBe('vertical')
  for(const text of ['个人资料','密码与安全','登录会话','登录记录','退出登录'])expect(document.body.textContent).toContain(text)
  await act(async()=>tab('通用偏好').click())
  await vi.waitFor(()=>expect(document.querySelector('.personal-settings-general')?.parentElement?.querySelector('h2')?.textContent).toBe('通用偏好'))
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="自动保存"]')!.click())
  await act(async()=>tab('个人技能').click())
  expect(document.body.textContent).toContain('个人技能列表')
  await act(async()=>tab('通用偏好').click())
  expect(document.querySelector('[aria-label="自动保存"]')?.getAttribute('aria-checked')).toBe('true')
  expect(document.querySelector('.personal-settings-actions')?.textContent).toContain('保存个人偏好')
  expect(save).not.toHaveBeenCalled()
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})

test('B theme previews use labelled native radios and only update the draft',async()=>{
 document.body.innerHTML='<div id="theme-test"></div>'
 const root=createRoot(document.getElementById('theme-test')!),save=vi.fn()
 const initial={theme:'light' as const,language:'zh' as const,authorName:'Original',autoSave:false,showAssistant:true}
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},activeTab:'general',load:async()=>initial,save,sessionsClient:{listPage:async()=>({sessions:[],nextCursor:null}),list:async()=>[],revoke:async()=>{},revokeOthers:async()=>{}},historyClient:{list:async()=>[],listPage:async()=>({events:[],nextCursor:null})},security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{}})))
  const group=document.querySelector('fieldset[aria-label="主题"]')!
  expect(group).not.toBeNull()
  expect(group.querySelectorAll('input[type=radio]')).toHaveLength(3)
  const dark=group.querySelector<HTMLInputElement>('input[value=dark]')!
  dark.focus();expect(document.activeElement).toBe(dark)
  await act(async()=>dark.click())
  expect(dark.checked).toBe(true)
  expect(save).not.toHaveBeenCalled()
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})
