import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LocalAdminPanel} from '../../src/shell/LocalAdminPanel'
import {PasswordActionForm} from '../../src/shell/PasswordActionForm'
import type {LocalAdminClient} from '../../src/shell/local-admin-client'
for(const mode of ['admin','password-action'] as const)test(`${mode} preserves labeled account fields and explicit actions`,async()=>{
 document.body.innerHTML='<div id="test"></div>'
 const root=createRoot(document.getElementById('test')!)
 const client={list:async()=>({users:[{id:'other',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null})} as unknown as LocalAdminClient
 root.render(mode==='admin'?h(LocalAdminPanel,{currentUserId:'self',onClose:()=>{},onSessionRotated:()=>{},client}):h(PasswordActionForm,{onClose:()=>{},client}))
 try{
 await vi.waitFor(()=>expect(document.querySelectorAll('input').length).toBeGreaterThan(0))
 if(mode==='admin'){
  await vi.waitFor(()=>expect(document.body.textContent).toContain('Alice'))
  expect(document.querySelector('input[name="username"]')).toBeNull()
  ;[...document.querySelectorAll('button')].find(button=>button.textContent==='新建用户')!.click()
  await vi.waitFor(()=>expect(document.querySelector('form')).not.toBeNull())
 }
 const form=document.querySelector('form')!
 const names=[...form.querySelectorAll('input')].map(input=>input.name).filter(Boolean)
 if(mode==='admin'){
  expect(names).toEqual(['username','displayName'])
  for(const input of form.querySelectorAll('input'))expect(input.closest('label')?.textContent).toMatch(/新用户名|显示名称/)
  const create=[...document.querySelectorAll('button')].find(button=>button.textContent==='创建账号')!
  expect(create.type).toBe('submit')
  expect(document.body.textContent).toContain('已启用')
  expect(document.body.textContent).toContain('个人用户')
 }else{
  expect(names).toEqual(['token','password','confirm'])
  expect(document.querySelector('[aria-label="用途"]')).toBeNull()
  expect(form.querySelector<HTMLInputElement>('[name=password]')?.type).toBe('password')
  expect(form.querySelector<HTMLInputElement>('[name=confirm]')?.autocomplete).toBe('new-password')
  const close=[...document.querySelectorAll('button')].find(button=>button.textContent==='返回登录')!
  expect(close.disabled).toBe(false)
 }
 }finally{root.unmount()}
})
import {LocalSessionsPanel} from '../../src/shell/LocalSessionsPanel'
import type {LocalSessionsClient} from '../../src/shell/local-sessions-client'
test('sessions label the actual current session and require confirmation before revocation',async()=>{
 document.body.innerHTML='<div id="test"></div>'
 const root=createRoot(document.getElementById('test')!)
 const client={listPage:async()=>({nextCursor:null,sessions:[{id:'self',current:true,createdAt:'2026-11-16T12:00:00Z',lastSeenAt:'2026-11-16T12:00:00Z',expiresAt:'2026-11-17T12:00:00Z'}]})} as unknown as LocalSessionsClient
 root.render(h(LocalSessionsPanel,{client,onCurrentRevoked:()=>{}}))
 try{
 await vi.waitFor(()=>expect(document.querySelector('li')).not.toBeNull())
 expect(document.querySelector('time')?.dateTime).toBe('2026-11-16T12:00:00Z')
 expect(document.body.textContent).toContain('当前浏览器会话')
 const revoke=[...document.querySelectorAll('button')].find(button=>button.textContent==='撤销当前会话')!
 revoke.click()
 await vi.waitFor(()=>expect(document.querySelector('[aria-label="确认撤销会话"]')?.textContent).toContain('重新加载并核对登录状态'))
 expect(document.querySelector('[data-session-id="self"]')).not.toBeNull()
 }finally{root.unmount()}
})
