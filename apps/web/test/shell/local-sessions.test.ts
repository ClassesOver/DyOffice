import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LocalSessionsPanel} from '../../src/shell/LocalSessionsPanel'
const current={id:'11111111-1111-4111-8111-111111111111',current:true,createdAt:'2026-11-16T00:00:00Z',lastSeenAt:'2026-11-16T01:00:00Z',expiresAt:'2026-11-17T00:00:00Z'}
const other={...current,id:'22222222-2222-4222-8222-222222222222',current:false}
async function mount(client:{list:()=>Promise<(typeof current)[]>;revoke:(id:string)=>Promise<void>},onCloseGuardChange?:(guard:(()=>boolean)|null)=>void){document.body.innerHTML='<div id="sessions-test"></div>';const root=createRoot(document.querySelector('#sessions-test')!);const exit=vi.fn();root.render(h(LocalSessionsPanel,{client:{...client,listPage:async()=>({sessions:await client.list(),nextCursor:null}),revokeOthers:async()=>{}},onCurrentRevoked:exit,onCloseGuardChange}));await vi.waitFor(()=>expect(document.querySelectorAll('[data-session-id]').length).toBe(2));const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!;return {root,exit,button}}
test('session revoke requires explicit confirmation and current-session success starts recovery',async()=>{const revoke=vi.fn(async()=>{});const f=await mount({list:async()=>[current,other],revoke});try{document.querySelector<HTMLButtonElement>('[data-session-id] button')!.click();expect(revoke).not.toHaveBeenCalled();await vi.waitFor(()=>expect(f.button('确认撤销')).toBeTruthy());f.button('确认撤销').click();await vi.waitFor(()=>expect(f.exit).toHaveBeenCalledOnce());expect(revoke).toHaveBeenCalledWith(current.id)}finally{f.root.unmount()}})
test('failed revoke preserves rows, has no success or logout, and can be reconciled by refresh',async()=>{const revoke=vi.fn(async()=>{throw new Error('unknown')});const f=await mount({list:async()=>[current,other],revoke});try{document.querySelector<HTMLButtonElement>('[data-session-id] button')!.click();await vi.waitFor(()=>expect(f.button('确认撤销')).toBeTruthy());f.button('确认撤销').click();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')).not.toBeNull());expect(document.querySelectorAll('[data-session-id]').length).toBe(2);expect(f.exit).not.toHaveBeenCalled();expect(document.querySelector('[role=status]')).toBeNull()}finally{f.root.unmount()}})

test('bulk confirmation keeps current session and never calls current-session logout',async()=>{
 document.body.innerHTML='<div id="sessions-test"></div>';const root=createRoot(document.querySelector('#sessions-test')!);const exit=vi.fn();let bulkDone=false;const bulk=vi.fn(async()=>{bulkDone=true})
 root.render(h(LocalSessionsPanel,{client:{listPage:async()=>({sessions:bulkDone?[current]:[current,other],nextCursor:null}),list:async()=>[current,other],revoke:vi.fn(),revokeOthers:bulk},onCurrentRevoked:exit}))
 try{await vi.waitFor(()=>expect(document.querySelectorAll('[data-session-id]').length).toBe(2));const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!;button('撤销所有其他会话').click();expect(bulk).not.toHaveBeenCalled();await vi.waitFor(()=>expect(button('确认撤销')).toBeTruthy());button('确认撤销').click();await vi.waitFor(()=>expect(document.querySelectorAll('[data-session-id]').length).toBe(1));expect(document.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe(current.id);expect(exit).not.toHaveBeenCalled();expect(bulk).toHaveBeenCalledOnce()}finally{root.unmount()}
})

test('session guard blocks closing a revoke in flight and confirms an unverified result until refresh',async()=>{
 let guard:(()=>boolean)|null=null,reject!:(error:Error)=>void
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 const f=await mount({list:async()=>[current,other],revoke:()=>new Promise<void>((_resolve,no)=>{reject=no})},next=>{guard=next})
 try{
  expect(guard?.()).toBe(true)
  f.button('撤销此会话').click()
  await vi.waitFor(()=>expect(f.button('确认撤销')).toBeTruthy())
  f.button('确认撤销').click()
  expect(guard?.()).toBe(false)
  expect(confirm).not.toHaveBeenCalled()
  reject(new TypeError('unknown'))
  await vi.waitFor(()=>expect(document.querySelector('[role=alert]')).not.toBeNull())
  expect(guard?.()).toBe(false)
  expect(confirm).toHaveBeenCalledOnce()
  f.button('刷新会话列表').click()
  await vi.waitFor(()=>expect(document.querySelector('[role=alert]')).toBeNull())
  await vi.waitFor(()=>expect(f.button('撤销此会话').disabled).toBe(false))
  expect(guard?.()).toBe(true)
 }finally{f.root.unmount();confirm.mockRestore()}
})

test('current-session revocation releases its unload guard before recovery and prevents further requests',async()=>{
 document.body.innerHTML='<div id="sessions-test"></div>';const root=createRoot(document.querySelector('#sessions-test')!)
 const protectedReload=()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented}
 const list=vi.fn(async()=>[current,other]),revoke=vi.fn(async()=>{}),revokeOthers=vi.fn(async()=>{})
 let blockedAtRecovery:boolean|undefined
 const recovery=vi.fn(()=>{blockedAtRecovery=protectedReload()})
 root.render(h(LocalSessionsPanel,{client:{listPage:async()=>({sessions:await list(),nextCursor:null}),list,revoke,revokeOthers},onCurrentRevoked:recovery}))
 try{
  await vi.waitFor(()=>expect(document.querySelectorAll('[data-session-id]').length).toBe(2))
  const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!
  button('撤销当前会话').click();await vi.waitFor(()=>expect(button('确认撤销')).toBeTruthy());button('确认撤销').click()
  await vi.waitFor(()=>expect(recovery).toHaveBeenCalledOnce())
  expect(blockedAtRecovery).toBe(false)
  expect(document.querySelector('[role=status]')?.textContent).toContain('当前会话已撤销')
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(item=>item.disabled)).toBe(true)
  button('刷新会话列表').click();button('撤销所有其他会话').click()
  expect(list).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledOnce();expect(revokeOthers).not.toHaveBeenCalled();expect(recovery).toHaveBeenCalledOnce()
  const editorGuard=(event:BeforeUnloadEvent)=>event.preventDefault()
  window.addEventListener('beforeunload',editorGuard)
  try{expect(protectedReload()).toBe(true)}finally{window.removeEventListener('beforeunload',editorGuard)}
  expect(protectedReload()).toBe(false)
 }finally{root.unmount()}
})
