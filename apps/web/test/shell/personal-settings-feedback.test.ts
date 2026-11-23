import {test,expect,vi} from 'vitest'
import {createElement as h,act} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from '../../src/shell/WorkspaceSettings'
import {LocalPasswordForm} from '../../src/shell/LocalPasswordForm'
const initial={theme:'light' as const,language:'zh' as const,authorName:'Original',autoSave:false,showAssistant:true}
test('preference drafts can be reverted locally and submitted by the form',async()=>{
 document.body.innerHTML='<div id="draft-test"></div>'
 const root=createRoot(document.getElementById('draft-test')!),load=vi.fn(async()=>initial),save=vi.fn(async()=>({...initial,autoSave:true}))
 let guard:(()=>boolean)|null=null
 const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},activeTab:'general',load,save,security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:null,onClose:()=>{},onLogout:()=>{},onCloseGuardChange:value=>{guard=value}})))
  expect(document.querySelector('.personal-page-save-state')?.textContent).toContain('所有更改已保存')
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="自动保存"]')!.click())
  expect(document.querySelector('.personal-page-save-state')?.textContent).toContain('有未保存的更改')
  await act(async()=>button('撤销更改').click())
  expect(document.querySelector('[aria-label="自动保存"]')?.getAttribute('aria-checked')).toBe('false')
  expect(load).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();expect(guard?.()).toBe(true)
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="自动保存"]')!.click())
  await act(async()=>document.querySelector('.personal-page-general')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(save).toHaveBeenCalledWith({autoSave:true})
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})
test('personal settings top tabs switch categories and keep the selected category state',async()=>{
 document.body.innerHTML='<div id="settings-navigation-test"></div>'
 const root=createRoot(document.getElementById('settings-navigation-test')!)
 const changed=vi.fn()
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save:vi.fn(),security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:null,onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{},onTabChange:changed})))
  const skills=[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item=>item.textContent?.includes('个人技能'))!
  await act(async()=>skills.click())
  expect(skills.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('[role=tabpanel]:not([hidden]) .personal-page-heading h2')?.textContent).toBe('个人技能')
  expect(changed).toHaveBeenCalledWith('skills')
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})
test('preference save failure retains the draft for retry and exposes pending status',async()=>{
 document.body.innerHTML='<div id="save-failure-test"></div>'
 const root=createRoot(document.getElementById('save-failure-test')!)
 let fail!:(error:Error)=>void
 const save=vi.fn(()=>new Promise<typeof initial>((_resolve,reject)=>{fail=reject}))
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},activeTab:'general',load:async()=>initial,save,security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:null,onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{}})))
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="自动保存"]')!.click())
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='保存个人偏好')!.click())
  expect(document.querySelector('.personal-page-save-state')?.textContent).toContain('正在保存')
  await act(async()=>fail(new Error('保存服务暂不可用')))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('保存服务暂不可用')
  expect(document.querySelector('[aria-label="自动保存"]')?.getAttribute('aria-checked')).toBe('true')
  expect(document.querySelector('.personal-page-save-state')?.textContent).toContain('有未保存的更改')
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})
test('invalid password confirmation focuses its field and clearing inputs releases the close guard',async()=>{
 document.body.innerHTML='<div id="password-feedback-test"></div>'
 const root=createRoot(document.getElementById('password-feedback-test')!),change=vi.fn()
 let guard:(()=>boolean)|null=null
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 try{
  await act(async()=>root.render(h(LocalPasswordForm,{changePassword:change,reload:()=>{},onCloseGuardChange:next=>{guard=next}})))
  const form=document.querySelector('form')!
  await act(async()=>{for(const [name,value] of Object.entries({currentPassword:'existing long password',newPassword:'new long password phrase',confirmation:'different'})){const input=form.elements.namedItem(name) as HTMLInputElement;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}})
  expect(guard?.()).toBe(false)
  await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  const input=form.elements.namedItem('confirmation') as HTMLInputElement
  expect(document.activeElement).toBe(input);expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toContain('不一致')
  await act(async()=>[...form.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='清空输入')!.click())
  expect([...form.querySelectorAll('input')].every(node=>node.value==='')).toBe(true)
  expect(document.querySelector('[role=alert]')).toBeNull();expect(guard?.()).toBe(true);expect(change).not.toHaveBeenCalled()
 }finally{await act(async()=>root.unmount());confirm.mockRestore()}
})

test('failed preference loading leaves retry available and announces the loading state',async()=>{
 document.body.innerHTML='<div id="load-feedback-test"></div>'
 const root=createRoot(document.getElementById('load-feedback-test')!)
 let reject!:(error:Error)=>void
 const load=vi.fn().mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no})).mockResolvedValue(initial)
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},activeTab:'general',load,save:vi.fn(),security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:null,onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{}})))
  expect(document.querySelector('.personal-page-save-state')?.textContent).toContain('正在读取')
  await act(async()=>reject(new Error('暂时无法读取')))
  const retry=[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='重新读取')!
  expect(retry.disabled).toBe(false)
  await act(async()=>retry.click())
  expect(load).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role=alert]')).toBeNull()
  expect(document.querySelector<HTMLInputElement>('[aria-label="文档作者"]')?.value).toBe('Original')
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})

test('preference actions belong only to general settings while drafts remain protected',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text&&!b.closest('[hidden]'))
 let guard:(()=>boolean)|null=null
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save:vi.fn(),security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:g=>{guard=g}})))
  expect(button('保存个人偏好')).toBeUndefined()
  await act(async()=>button('通用偏好')!.click())
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="自动保存"]')!.click())
  await act(async()=>button('个人技能')!.click())
  expect(button('保存个人偏好')).toBeUndefined();expect(host.textContent).toContain('通用偏好有未保存的更改')
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);expect(guard?.()).toBe(false);confirm.mockRestore()
  await act(async()=>button('通用偏好')!.click())
  expect(button('保存个人偏好')!.disabled).toBe(false)
 }finally{await act(async()=>root.unmount());host.remove()}
})
