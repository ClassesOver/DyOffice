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
  const pane=document.querySelector('.personal-settings-general')!
  const label=(name:string)=>[...pane.querySelectorAll<HTMLLabelElement>('label')].find(element=>element.textContent===name)!
  for(const name of ['语言','文档作者','自动保存','显示 AI 助手']){
   const control=pane.querySelector<HTMLElement>(`[aria-label="${name}"]`)!
   expect(label(name).control,name).toBe(control)
  }
  for(const [name,checked] of [['自动保存','true'],['显示 AI 助手','false']]){
   await act(async()=>label(name).click())
   expect(label(name).control?.getAttribute('aria-checked')).toBe(checked)
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
 await vi.waitFor(()=>expect([...document.querySelectorAll('.settings-workbench-nav-item')].some(t=>t.textContent==='通用偏好')).toBe(true))
 ;([...document.querySelectorAll<HTMLElement>('.settings-workbench-nav-item')].find(t=>t.textContent==='通用偏好')!).click()
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
  await act(async()=>button(outcome==='current'?'撤销当前会话':'撤销此会话').click())
  await act(async()=>button('确认撤销').click())
  expect(revoke).toHaveBeenCalledOnce()
  expect(guard?.()).toBe(false)
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
