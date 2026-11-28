import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from '../../src/shell/WorkspaceSettings'
const initial={theme:'light' as const,language:'zh' as const,authorName:'Original',autoSave:false,showAssistant:true}
test('preference labels associate with their controls and switch labels toggle only the draft',async()=>{
 const {act}=await import('react')
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 document.body.innerHTML='<div id="labels-test"></div>'
 const root=createRoot(document.getElementById('labels-test')!),save=vi.fn(async()=>initial)
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save,sessionsClient:{listPage:async()=>({sessions:[],nextCursor:null}),list:async()=>[],revoke:async()=>{},revokeOthers:async()=>{}},historyClient:{list:async()=>[],listPage:async()=>({events:[],nextCursor:null})},security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{},activeTab:'general'})))
  const pane=document.querySelector('.personal-page-general')!
  const label=(name:string)=>[...pane.querySelectorAll<HTMLLabelElement>('label')].find(element=>element.textContent===name)!
  for(const name of ['语言','文档作者','自动保存']){
   const control=pane.querySelector<HTMLElement>(`[aria-label="${name}"]`)!
   expect(label(name).control,name).toBe(control)
  }
  const assistant=label('显示 AI 助手').control as HTMLInputElement
  expect(assistant.getAttribute('role')).toBe('switch')
  expect(document.getElementById(assistant.getAttribute('aria-describedby')!)?.textContent).toContain('仍可从功能区打开助手')
  for(const [name,checked] of [['自动保存',true],['显示 AI 助手',false]] as const){
   await act(async()=>label(name).click())
   expect((label(name).control as HTMLInputElement).checked).toBe(checked)
  }
  expect(save).not.toHaveBeenCalled()
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})
test('preferences remain drafts until explicit save and pending save prevents tab closure',async()=>{
 document.body.innerHTML='<div id="test"></div>'
 const root=createRoot(document.getElementById('test')!)
 let guard:(()=>boolean)|null=null,finish:(v:typeof initial)=>void=()=>{}
 const save=vi.fn(()=>new Promise<typeof initial>(resolve=>{finish=resolve}))
 root.render(h(WorkspaceSettings,{user:{username:'admin',displayName:'Admin',roles:['personal']},load:async()=>initial,save,security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:g=>{guard=g}}))
 try{
 await vi.waitFor(()=>expect([...document.querySelectorAll('[role="tab"]')].some(t=>t.textContent==='通用偏好')).toBe(true))
 ;([...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(t=>t.textContent==='通用偏好')!).click()
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
 const list=vi.spyOn(localSessionsClient,'listPage').mockImplementation(async()=>({sessions:[session(rotated?'replacement-session':'old-session')],nextCursor:null}))
 const history=vi.spyOn(loginHistoryClient,'listPage').mockResolvedValue({events:[],nextCursor:null})
 document.body.innerHTML='<div id="rotation-test"></div>'
 const root=createRoot(document.getElementById('rotation-test')!)
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save:async()=>initial,security:{changePassword:async()=>{rotated=true},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{}})))
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(tab=>tab.textContent==='登录活动')!.click())
  expect(document.querySelector('[data-session-id="old-session"]')).not.toBeNull()
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(tab=>tab.textContent==='资料与安全')!.click())
  const current=document.querySelector<HTMLInputElement>('#local-current-password')!,next=document.querySelector<HTMLInputElement>('#local-new-password')!,confirm=document.querySelector<HTMLInputElement>('#local-confirm-password')!
  current.value='existing long password';next.value=confirm.value='new long password phrase'
  await act(async()=>current.form!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(list).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[data-session-id="replacement-session"]')).not.toBeNull()
  expect(document.querySelector('[data-session-id="old-session"]')).toBeNull()
  expect(document.querySelector('.personal-account-password [role="status"]')?.textContent).toContain('当前会话已更新')
 }finally{await act(async()=>root.unmount());list.mockRestore();history.mockRestore();document.body.innerHTML=''}
})

for(const outcome of ['success','unknown','current'] as const)test(`password rotation preserves a pending session revocation and reconciles afterwards (${outcome})`,async()=>{
 const {act}=await import('react')
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 const session=(id:string,current:boolean)=>({id,current,createdAt:'2026-01-01T00:00:00Z',lastSeenAt:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z'})
 let finish:()=>void=()=>{},fail:(error:Error)=>void=()=>{},guard:(()=>boolean)|null=null
 const revoke=vi.fn(()=>new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject}))
 const list=vi.fn().mockResolvedValueOnce([session('current',true),session('other',false)])
 if(outcome==='success')list.mockResolvedValue([session('replacement',true)])
 else list.mockRejectedValue(new Error('read unavailable'))
 const client={listPage:async()=>({sessions:await list(),nextCursor:null}),list,revoke,revokeOthers:vi.fn()},onCurrentRevoked=vi.fn()
 document.body.innerHTML='<div id="pending-rotation-test"></div>'
 const root=createRoot(document.getElementById('pending-rotation-test')!)
 const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save:async()=>initial,sessionsClient:client,historyClient:{list:async()=>[],listPage:async()=>({events:[],nextCursor:null})},security:{changePassword:async()=>{},onCurrentRevoked},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:g=>{guard=g}})))
  await act(async()=>button('登录活动').click())
  await act(async()=>button(outcome==='current'?'撤销当前会话':'撤销此会话').click())
  await act(async()=>button('确认撤销').click())
  expect(revoke).toHaveBeenCalledOnce()
  expect(guard?.()).toBe(false)
  await act(async()=>button('资料与安全').click())
  const current=document.querySelector<HTMLInputElement>('#local-current-password')!,next=document.querySelector<HTMLInputElement>('#local-new-password')!,confirm=document.querySelector<HTMLInputElement>('#local-confirm-password')!
  current.value='existing long password';next.value=confirm.value='new long password phrase'
  await act(async()=>current.form!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(document.querySelector('.personal-account-password [role="status"]')?.textContent).toContain('当前会话已更新')
  expect(guard?.()).toBe(false)
  expect(button('刷新会话列表').disabled).toBe(true)
  expect(list).toHaveBeenCalledTimes(1)
  const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true)
  await act(async()=>{if(outcome!=='unknown')finish();else fail(new Error('response lost'))})
  expect(list).toHaveBeenCalledTimes(outcome==='current'?1:2)
  if(outcome==='current'){
   expect(onCurrentRevoked).toHaveBeenCalledOnce()
   expect(document.querySelector('[data-session-id]')).toBeNull()
   expect(button('刷新会话列表').disabled).toBe(true)
   expect(guard?.()).toBe(true)
  }else if(outcome==='success'){
   expect(document.querySelector('[data-session-id="replacement"]')).not.toBeNull()
   expect(guard?.()).toBe(true)
  }else{
   expect(document.body.textContent).toContain('无法读取登录会话')
   expect(button('撤销此会话').disabled).toBe(true)
   const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
   try{expect(guard?.()).toBe(false)}finally{confirm.mockRestore()}
  }
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})

test('native category tabs support keyboard navigation and preserve visited activity and password drafts',async()=>{
 const {act}=await import('react')
 document.body.innerHTML='<div id="native-settings-tabs"></div>'
 const root=createRoot(document.getElementById('native-settings-tabs')!)
 let guard:(()=>boolean)|null=null
 const listPage=vi.fn(async()=>({sessions:[],nextCursor:null}))
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 const tab=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(node=>node.textContent===name)!
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save:async()=>initial,sessionsClient:{listPage,list:async()=>[],revoke:async()=>{},revokeOthers:async()=>{}},historyClient:{list:async()=>[],listPage:async()=>({events:[],nextCursor:null})},security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'native skill content'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:next=>{guard=next}})))
  expect([...document.querySelectorAll('[role=tab]')].map(node=>node.textContent)).toEqual(['资料与安全','登录活动','通用偏好','个人技能'])
  expect(listPage).not.toHaveBeenCalled()
  const input=document.querySelector<HTMLInputElement>('#local-current-password')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'password draft');input.dispatchEvent(new Event('input',{bubbles:true}))})
  await act(async()=>tab('资料与安全').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
  expect(tab('登录活动').getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(tab('登录活动'))
  expect(listPage).toHaveBeenCalledOnce()
  expect(document.querySelector('[role=tabpanel]:not([hidden]) .personal-page-sessions')).not.toBeNull()
  expect(document.querySelector('[role=tabpanel]:not([hidden]) #local-current-password')).toBeNull()
  expect(guard?.()).toBe(false)
  await act(async()=>tab('登录活动').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})))
  expect(tab('个人技能').getAttribute('aria-selected')).toBe('true')
  await act(async()=>tab('个人技能').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})))
  expect(tab('资料与安全').getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector<HTMLInputElement>('#local-current-password')).toBe(input)
  expect(input.value).toBe('password draft')
  await act(async()=>tab('资料与安全').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})))
  expect(tab('个人技能').getAttribute('aria-selected')).toBe('true')
  await act(async()=>tab('登录活动').click())
  expect(listPage).toHaveBeenCalledOnce()
  expect(document.querySelector('.personal-settings-b,.ant-tabs,.ant-input,.ant-btn')).toBeNull()
 }finally{await act(async()=>root.unmount());confirm.mockRestore();document.body.innerHTML=''}
})

test('changing personal categories returns to the heading while preserving mounted drafts',async()=>{
 const {act}=await import('react')
 document.body.innerHTML='<div id="category-scroll-test"></div>'
 const root=createRoot(document.getElementById('category-scroll-test')!)
 try{
  await act(async()=>root.render(h(WorkspaceSettings,{user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>initial,save:async()=>initial,security:{changePassword:async()=>{},onCurrentRevoked:()=>{}},skills:h('p',null,'skills'),onClose:()=>{},onLogout:()=>{},onCloseGuardChange:()=>{}})))
  const content=document.querySelector<HTMLElement>('.personal-page-content')!
  content.scrollTop=300
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(tab=>tab.textContent==='通用偏好')!.click())
  expect(content.scrollTop).toBe(0)
  content.scrollTop=180
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(tab=>tab.textContent==='个人技能')!.click())
  expect(content.scrollTop).toBe(0)
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})
