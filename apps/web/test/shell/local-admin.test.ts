import {test,expect,vi} from 'vitest'
import {createLocalAdminClient} from '../../src/shell/local-admin-client'
test('reauth and writes use fresh same-origin CSRF, without retry or token persistence',async()=>{
 const calls:{path:string;init?:RequestInit}[]=[]
 let seq=0
 const send=vi.fn(async(path:RequestInfo|URL,init?:RequestInit)=>{
  calls.push({path:String(path),init})
  return new Response(JSON.stringify(String(path).endsWith('/csrf')?{csrfToken:'csrf'+(++seq)}:String(path).endsWith('/reauth')?{csrfToken:'rotated'}:{user:{id:'01234567-89ab-4def-8abc-0123456789ab',username:'new',displayName:'New',status:'pending',roles:['personal'],requiresPasswordReset:false},action:{token:'a'.repeat(43),purpose:'activate',expiresAt:'2026-11-16T20:00:00Z'}}),{status:200})
 })
 const c=createLocalAdminClient(send)
 await c.reauthenticate('secret');await c.create('new','New')
 expect(calls.map(c=>c.path)).toEqual(['/api/v1/auth/csrf','/api/v1/auth/reauth','/api/v1/auth/csrf','/api/v1/admin/users'])
 expect(calls[3].init?.headers).toMatchObject({'X-CSRF-Token':'csrf2'})
 expect(calls.every(c=>c.init?.credentials==='same-origin'&&c.init.cache==='no-store'&&c.init.redirect==='error')).toBe(true)
 expect(calls[3].init?.body).not.toContain('secret')
})
test('failed mutation is not retried and arbitrary IDs/purposes fail before fetch',async()=>{
 const send=vi.fn(async(path:RequestInfo|URL)=>new Response(JSON.stringify(String(path).endsWith('/csrf')?{csrfToken:'x'}:{message:'no'}),{status:String(path).endsWith('/csrf')?200:403}))
 const c=createLocalAdminClient(send)
 await expect(c.create('x','')).rejects.toThrow()
 expect(send).toHaveBeenCalledTimes(2)
 await expect(c.issue('../x','reset')).rejects.toThrow()
 expect(send).toHaveBeenCalledTimes(2)
})
test('password action puts one-time token only in POST body and fetches fresh challenge every attempt',async()=>{
 const send=vi.fn(async(path:RequestInfo|URL)=>String(path).endsWith('/csrf')?new Response(JSON.stringify({csrfToken:'challenge'})):new Response(null,{status:204}))
 const c=createLocalAdminClient(send);const token='a'.repeat(43)
 await c.redeem(token,'activate','new password')
 expect(send.mock.calls[1]?.[0]).toBe('/api/v1/auth/password-action')
 const init=send.mock.calls[1]?.[1] as RequestInit
 expect(JSON.parse(String(init.body))).toEqual({token,purpose:'activate',password:'new password'})
})

import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LocalAdminPanel} from '../../src/shell/LocalAdminPanel'
import {PasswordActionForm} from '../../src/shell/PasswordActionForm'
import type {LocalAdminClient} from '../../src/shell/local-admin-client'
function mount(node:ReturnType<typeof h>){document.body.innerHTML='<div id="test"></div>';const root=createRoot(document.getElementById('test')!);root.render(node);return root}
test('admin confirms target and reauth before mutation; duplicate clicks cannot issue twice',async()=>{
 let finish!:()=>void
 const wait=new Promise<void>(r=>{finish=r})
 const client={list:vi.fn(async()=>({users:[{id:'target',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null})),reauthenticate:vi.fn(async()=>wait),issue:vi.fn(async()=>({action:{token:'a'.repeat(43),purpose:'reset',expiresAt:'later'}}))} as unknown as LocalAdminClient
 const rotated=vi.fn(),root=mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:rotated,client}))
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Alice'))
 ;([...document.querySelectorAll('button')].find(b=>b.textContent==='重置密码')!).click()
 await vi.waitFor(()=>expect(document.querySelector('form[aria-label]')).not.toBeNull())
 const form=document.querySelector<HTMLFormElement>('form[aria-label]')!;form.querySelector<HTMLInputElement>('input')!.value='secret'
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 expect(client.reauthenticate).toHaveBeenCalledTimes(1);expect(client.issue).not.toHaveBeenCalled()
 finish();await vi.waitFor(()=>expect(client.issue).toHaveBeenCalledOnce())
 expect(rotated).toHaveBeenCalledOnce()
 await vi.waitFor(()=>expect(document.querySelector<HTMLInputElement>('[aria-label="一次性码"]')?.value).toHaveLength(43))
 expect(form.querySelector('input')?.value||'').toBe('')
 root.unmount();expect(document.body.textContent).not.toContain('a'.repeat(43))
})
test('password mismatch sends nothing; failure clears secrets and does not claim success',async()=>{
 const redeem=vi.fn(async()=>{throw new Error('rejected')}),root=mount(h(PasswordActionForm,{onClose:()=>{},client:{redeem} as unknown as LocalAdminClient}))
 await vi.waitFor(()=>expect(document.querySelector('form')).not.toBeNull())
 const form=document.querySelector('form')!
 const set=(name:string,value:string)=>{form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value=value}
 set('token','a'.repeat(43));set('password','one');set('confirm','two')
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(redeem).not.toHaveBeenCalled()
 set('confirm','one');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toContain('rejected'))
 expect(form.querySelector<HTMLInputElement>('[name="token"]')!.value).toBe('')
 expect(document.querySelector('[role="status"]')).toBeNull();expect(redeem).toHaveBeenCalledOnce()
 root.unmount()
})
test('malformed 2xx DTOs never report successful actions',async()=>{
 const send=vi.fn(async(path:RequestInfo|URL)=>new Response(JSON.stringify(String(path).endsWith('/csrf')?{csrfToken:'x'}:{}),{status:200}))
 const c=createLocalAdminClient(send),id='01234567-89ab-4def-8abc-0123456789ab'
 await expect(c.list()).rejects.toThrow()
 await expect(c.reauthenticate('secret')).rejects.toThrow()
 await expect(c.create('x','')).rejects.toThrow()
 await expect(c.issue(id,'reset')).rejects.toThrow()
 await expect(c.setStatus(id,'disabled')).rejects.toThrow()
 await expect(c.redeem('a'.repeat(43),'activate','new')).rejects.toThrow()
})
test('reauth network failure clears shared CSRF and never starts the admin mutation',async()=>{
 const client={list:vi.fn(async()=>({users:[],nextCursor:null})),reauthenticate:vi.fn(async()=>{throw new Error('network outcome unknown')}),create:vi.fn()} as unknown as LocalAdminClient
 const rotated=vi.fn(),root=mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:rotated,client}))
 await vi.waitFor(()=>expect(document.querySelector<HTMLInputElement>('input[name="username"]')?.disabled).toBe(false))
 const createForm=document.querySelector('form')!;createForm.querySelector<HTMLInputElement>('[name="username"]')!.value='new'
 createForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 await vi.waitFor(()=>expect(document.querySelector('form[aria-label]')).not.toBeNull())
 const form=document.querySelector('form[aria-label]')!;form.querySelector<HTMLInputElement>('input')!.value='secret';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 await vi.waitFor(()=>expect(rotated).toHaveBeenCalledOnce())
 expect(client.create).not.toHaveBeenCalled();expect(document.querySelector('[aria-label="一次性码"]')).toBeNull()
 root.unmount()
})
test('successful redemption shows return-to-login result without retaining the code',async()=>{
 const redeem=vi.fn(async()=>{}),root=mount(h(PasswordActionForm,{onClose:()=>{},client:{redeem} as unknown as LocalAdminClient}))
 await vi.waitFor(()=>expect(document.querySelector('form')).not.toBeNull())
 const form=document.querySelector('form')!
 for(const [name,value] of [['token','a'.repeat(43)],['password','same'],['confirm','same']])form.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value=value
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 await vi.waitFor(()=>expect(document.querySelector('[role="status"]')?.textContent).toContain('不会自动登录'))
 expect(document.querySelector('form')).toBeNull();expect(redeem).toHaveBeenCalledOnce();root.unmount()
})
test('role replacement accepts only explicit known nonduplicate roles',async()=>{
 const send=vi.fn(async()=>new Response('{}'))
 const client=createLocalAdminClient(send)
 await expect(client.setRoles('01234567-89ab-4def-8abc-0123456789ab',['root'])).rejects.toThrow()
 await expect(client.setRoles('01234567-89ab-4def-8abc-0123456789ab',['personal','personal'])).rejects.toThrow()
 expect(send).not.toHaveBeenCalled()
})
test('self role replacement is explicit, preserves personal and requires a fresh login on success',async()=>{
 const client={list:vi.fn(async()=>({users:[{id:'me',username:'owner',displayName:'',status:'active',roles:['personal','config_admin'],requiresPasswordReset:false}],nextCursor:null})),reauthenticate:vi.fn(async()=>{}),setRoles:vi.fn(async()=>({user:{id:'me'}}))} as unknown as LocalAdminClient
 const changed=vi.fn(),root=mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},onOwnAuthorityChanged:changed,client}))
 await vi.waitFor(()=>expect([...document.querySelectorAll('button')].some(b=>b.textContent==='编辑角色')).toBe(true))
 ;([...document.querySelectorAll('button')].find(b=>b.textContent==='编辑角色')!).click()
 await vi.waitFor(()=>expect(document.querySelector('fieldset')?.textContent).toContain('必须重新登录'))
 document.querySelector<HTMLInputElement>('[name="role"][value="config_admin"]')!.checked=false
 const form=document.querySelector('form[aria-label]')!;form.querySelector<HTMLInputElement>('[name="password"]')!.value='secret';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce())
 expect(client.setRoles).toHaveBeenCalledWith('me',['personal']);root.unmount()
})
