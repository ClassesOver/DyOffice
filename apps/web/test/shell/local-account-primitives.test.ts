import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LocalAdminPanel} from '../../src/shell/LocalAdminPanel'
import {PasswordActionForm} from '../../src/shell/PasswordActionForm'
import type {LocalAdminClient} from '../../src/shell/local-admin-client'
for(const mode of ['admin','password-action'] as const)test(`${mode} uses original Settings input and button primitives`,async()=>{
 document.body.innerHTML='<div id="test"></div>'
 const root=createRoot(document.getElementById('test')!)
 const client={list:async()=>({users:[{id:'other',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null})} as unknown as LocalAdminClient
 root.render(mode==='admin'?h(LocalAdminPanel,{currentUserId:'self',onClose:()=>{},onSessionRotated:()=>{},client}):h(PasswordActionForm,{onClose:()=>{},client}))
 try{
 await vi.waitFor(()=>expect(document.querySelectorAll('input').length).toBeGreaterThan(0))
 if(mode==='admin')await vi.waitFor(()=>expect(document.body.textContent).toContain('Alice'))
 for(const input of document.querySelectorAll('input'))expect(input.classList.contains('set-input')).toBe(true)
 for(const button of document.querySelectorAll('button'))expect(button.classList.contains('set-btn')).toBe(true)
 expect(document.querySelector('.set-pane > button')).toBeNull()
 if(mode==='admin'){expect(document.querySelector('ul')?.style.listStyle).toBe('none');expect(document.querySelector('li')?.classList.contains('set-field')).toBe(true)}
 }finally{root.unmount()}
})
import {LocalSessionsPanel} from '../../src/shell/LocalSessionsPanel'
import type {LocalSessionsClient} from '../../src/shell/local-sessions-client'
test('sessions use original Settings row and grouped actions rather than default bullet layout',async()=>{
 document.body.innerHTML='<div id="test"></div>'
 const root=createRoot(document.getElementById('test')!)
 const client={list:async()=>[{id:'self',current:true,createdAt:'2026-11-16T12:00:00Z',lastSeenAt:'2026-11-16T12:00:00Z',expiresAt:'2026-11-17T12:00:00Z'}]} as unknown as LocalSessionsClient
 root.render(h(LocalSessionsPanel,{client,onCurrentRevoked:()=>{}}))
 try{
 await vi.waitFor(()=>expect(document.querySelector('li')).not.toBeNull())
 expect(document.querySelector('ul')?.style.listStyle).toBe('none')
 expect(document.querySelector('li')?.classList.contains('set-field')).toBe(true)
 expect(document.querySelector('.set-btn-row')?.textContent).toContain('刷新会话列表')
 }finally{root.unmount()}
})
