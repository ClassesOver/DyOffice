import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from '../../src/shell/WorkspaceSettings'
import {createLocalPreferencesSession} from '../../src/shell/local-preferences-session'
import {createLocalShellClient} from '../../src/shell/local-client'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'

const initial={theme:'light' as const,language:'zh' as const,authorName:'Alice',autoSave:false,showAssistant:true}
test('settings retains drafts, close guard and unknown write across verified session rotation',async()=>{
 document.body.innerHTML='<div id="prefs"></div>'
 const root=createRoot(document.getElementById('prefs')!)
 const client=createLocalShellClient(async()=>{throw Error('unexpected transport')})
 const scoped=createLocalPreferencesSession(client)
 let finish:(value:typeof initial)=>void=()=>{},writes=0,guard:(()=>boolean)|null=null
 scoped.bind({proof:'a'.repeat(43),request:(async(_path,method)=>method==='PUT'?(writes++,new Promise(resolve=>{finish=resolve})):initial) as SettingsRequest})
 const props={user:{username:'alice',displayName:'Alice',roles:['personal']},activeTab:'general',load:scoped.preferences.getPreferences,save:scoped.preferences.updatePreferences,security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),sessionsClient:{listPage:async()=>({sessions:[],nextCursor:null}),list:async()=>[],revoke:async()=>{},revokeOthers:async()=>{}},historyClient:{list:async()=>[],listPage:async()=>({events:[],nextCursor:null})},onClose:()=>{},onLogout:()=>{},onCloseGuardChange:(g:(()=>boolean)|null)=>{guard=g}}
 const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 try{
  root.render(h(WorkspaceSettings,props))
  await vi.waitFor(()=>expect(document.querySelector('[aria-label="自动保存"]')?.getAttribute('aria-checked')).toBe('false'))
  await vi.waitFor(()=>expect((document.querySelector('[aria-label="文档作者"]') as HTMLInputElement)?.value).toBe('Alice'))
  const author=document.querySelector('[aria-label="文档作者"]')
  ;(document.querySelector('[aria-label="自动保存"]') as HTMLElement).click()
  await vi.waitFor(()=>expect(button('保存个人偏好').disabled).toBe(false))
  button('保存个人偏好').click()
  await vi.waitFor(()=>expect(writes).toBe(1));expect(guard?.()).toBe(false)
  scoped.bind({proof:'b'.repeat(43),request:(async(_path,method)=>{if(method==='PUT')writes++;return initial}) as SettingsRequest})
  root.render(h(WorkspaceSettings,{...props,security:{...props.security}}))
  finish({...initial,autoSave:true})
  await vi.waitFor(()=>expect(document.body.textContent).toContain('上次偏好保存结果尚未确认'))
  expect(document.body.textContent).not.toContain('个人偏好已保存')
  expect(document.querySelector('[aria-label="文档作者"]')).toBe(author)
  expect(document.querySelector('[aria-label="自动保存"]')?.getAttribute('aria-checked')).toBe('true')
  expect(guard?.()).toBe(false)
  button('保存个人偏好').click()
  await vi.waitFor(()=>expect(document.body.textContent).toContain('上次保存结果尚未确认'));expect(writes).toBe(1)
  confirm.mockReturnValue(true);button('重新读取').click()
  await vi.waitFor(()=>expect(document.querySelector('[aria-label="自动保存"]')?.getAttribute('aria-checked')).toBe('false'))
  ;(document.querySelector('[aria-label="自动保存"]') as HTMLElement).click()
  await vi.waitFor(()=>expect(button('保存个人偏好').disabled).toBe(false));button('保存个人偏好').click()
  await vi.waitFor(()=>expect(document.body.textContent).toContain('个人偏好已保存'));expect(writes).toBe(2)
 }finally{root.unmount();confirm.mockRestore()}
})
