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
 await c.redeem(token,'new password')
 expect(send.mock.calls[1]?.[0]).toBe('/api/v1/auth/password-action')
 const init=send.mock.calls[1]?.[1] as RequestInit
 expect(JSON.parse(String(init.body))).toEqual({token,password:'new password'})
})

import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LocalAdminPanel} from '../../src/shell/LocalAdminPanel'
import {PasswordActionForm} from '../../src/shell/PasswordActionForm'
import type {LocalAdminClient} from '../../src/shell/local-admin-client'
async function mount(node:ReturnType<typeof h>){document.body.innerHTML='<div id="test"></div>';const root=createRoot(document.getElementById('test')!);const environment=globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean};const previous=environment.IS_REACT_ACT_ENVIRONMENT;environment.IS_REACT_ACT_ENVIRONMENT=true;try{await act(async()=>root.render(node))}finally{environment.IS_REACT_ACT_ENVIRONMENT=previous}return root}
test('failed next member page retains loaded rows and cursor for an explicit retry',async()=>{
 const alice={id:'alice',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}
 const bob={...alice,id:'bob',username:'bob',displayName:'Bob'}
 const list=vi.fn().mockResolvedValueOnce({users:[alice],nextCursor:'alice'}).mockRejectedValueOnce(new Error('next page unavailable')).mockResolvedValueOnce({users:[bob],nextCursor:null})
 const root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},client:{list} as unknown as LocalAdminClient}))
 const next=()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='下一页')!
 try{
  await vi.waitFor(()=>expect(document.body.textContent).toContain('Alice'))
  expect(document.querySelector('.management-list-heading h3')?.textContent).toBe('成员与权限')
  next().click()
  await vi.waitFor(()=>expect(document.body.textContent).toContain('next page unavailable'))
  expect(document.body.textContent).toContain('Alice')
  expect(next()).toBeDefined()
  expect(next().disabled).toBe(false)
  next().click()
  await vi.waitFor(()=>expect(document.body.textContent).toContain('Bob'))
  expect(document.body.textContent).not.toContain('Alice')
  expect(document.body.textContent).not.toContain('next page unavailable')
  expect(next().disabled).toBe(true)
  expect(list.mock.calls).toEqual([[undefined],['alice'],['alice']])
 }finally{root.unmount()}
})
test('admin confirms target and reauth before mutation; duplicate clicks cannot issue twice',async()=>{
 let finish!:()=>void
 const wait=new Promise<void>(r=>{finish=r})
 const client={list:vi.fn(async()=>({users:[{id:'target',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null})),reauthenticate:vi.fn(async()=>wait),issue:vi.fn(async()=>({action:{token:'a'.repeat(43),purpose:'reset',expiresAt:'later'}}))} as unknown as LocalAdminClient
 const rotated=vi.fn(),root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:rotated,client}))
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
 const redeem=vi.fn(async()=>{throw new Error('rejected')}),root=await mount(h(PasswordActionForm,{onClose:()=>{},client:{redeem} as unknown as LocalAdminClient}))
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
 await expect(c.redeem('a'.repeat(43),'new')).rejects.toThrow()
})
test('reauth network failure clears shared CSRF and never starts the admin mutation',async()=>{
 const client={list:vi.fn(async()=>({users:[],nextCursor:null})),reauthenticate:vi.fn(async()=>{throw new Error('network outcome unknown')}),create:vi.fn()} as unknown as LocalAdminClient
 const rotated=vi.fn(),root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:rotated,client}))
 expect(document.querySelector('input[name="username"]')).toBeNull()
 ;[...document.querySelectorAll('button')].find(button=>button.textContent==='新建用户')!.click()
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
 const redeem=vi.fn(async()=>{}),root=await mount(h(PasswordActionForm,{onClose:()=>{},client:{redeem} as unknown as LocalAdminClient}))
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
 const changed=vi.fn(),root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},onOwnAuthorityChanged:changed,client}))
 await vi.waitFor(()=>expect([...document.querySelectorAll('button')].some(b=>b.textContent==='编辑角色')).toBe(true))
 ;([...document.querySelectorAll('button')].find(b=>b.textContent==='编辑角色')!).click()
 await vi.waitFor(()=>expect(document.querySelector('fieldset')?.textContent).toContain('必须重新登录'))
 document.querySelector<HTMLInputElement>('[name="role"][value="config_admin"]')!.checked=false
 const form=document.querySelector('form[aria-label]')!;form.querySelector<HTMLInputElement>('[name="password"]')!.value='secret';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
 await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce())
 expect(client.setRoles).toHaveBeenCalledWith('me',['personal']);root.unmount()
})
test('password setup uses a single form with a labeled one-time code field',async()=>{
 const root=await mount(h(PasswordActionForm,{onClose:()=>{}}))
 await vi.waitFor(()=>expect(document.querySelector('input[name=token]')?.getAttribute('aria-label')).toBe('一次性码'))
 expect(document.querySelector('[role=combobox]')).toBeNull()
 root.unmount()
})

test('user management labels roles and status in Chinese and protects an unfinished operation from tab closure',async()=>{
 let guard:(()=>boolean)|null=null
 const client={list:vi.fn(async()=>({users:[{id:'target',username:'alice',displayName:'Alice',status:'pending',roles:['personal','operator'],requiresPasswordReset:false}],nextCursor:null}))} as unknown as LocalAdminClient
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 const root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},client,onCloseGuardChange(next:(()=>boolean)|null){guard=next}}))
 try{
  await vi.waitFor(()=>expect(document.body.textContent).toContain('Alice'))
  expect(document.body.textContent).toContain('待设置密码')
  expect(document.body.textContent).toContain('运维人员')
  expect(guard?.()).toBe(true)
  ;([...document.querySelectorAll('button')].find(b=>b.textContent==='编辑角色')!).click()
  await vi.waitFor(()=>expect(document.querySelector('form[aria-label]')).not.toBeNull())
  expect(guard?.()).toBe(false)
  expect(confirm).toHaveBeenCalledOnce()
 }finally{root.unmount();confirm.mockRestore()}
})

test('a pending or unconfirmed admin write blocks duplicate operations until a successful refresh',async()=>{
 let guard:(()=>boolean)|null=null,fail!:(error:Error)=>void
 const client={list:vi.fn(async()=>({users:[{id:'target',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null})),reauthenticate:vi.fn(async()=>{}),setStatus:vi.fn(()=>new Promise((_resolve,reject)=>{fail=reject}))} as unknown as LocalAdminClient
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 const root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},client,onCloseGuardChange(next:(()=>boolean)|null){guard=next}}))
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label)!
 try{
  await vi.waitFor(()=>expect(document.body.textContent).toContain('Alice'))
  button('禁用账号').click();await vi.waitFor(()=>expect(document.querySelector('form[aria-label]')).not.toBeNull())
  const form=document.querySelector('form[aria-label]')!;form.querySelector<HTMLInputElement>('[aria-label="管理员当前密码"]')!.value='test-only'
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
  expect(guard?.()).toBe(false)
  expect(confirm).not.toHaveBeenCalled()
  await vi.waitFor(()=>expect(fail).toBeTypeOf('function'))
  fail(new TypeError('network result unknown'))
  await vi.waitFor(()=>expect(document.body.textContent).toContain('上次操作结果未确认'))
  expect(button('禁用账号').disabled).toBe(true)
  expect(guard?.()).toBe(false)
  expect(confirm).toHaveBeenCalledOnce()
  button('刷新列表').click()
  await vi.waitFor(()=>expect(button('禁用账号').disabled).toBe(false))
  expect(guard?.()).toBe(true)
 }finally{root.unmount();confirm.mockRestore()}
})

test('reauthentication clears actual typed administrator passwords while waiting for the server',async()=>{
 const {act}=await import('react')
 let finish!:()=>void
 const client={list:vi.fn(async()=>({users:[{id:'target',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null})),reauthenticate:vi.fn(()=>new Promise<void>(resolve=>{finish=resolve})),setStatus:vi.fn(async()=>({user:{id:'target'}}))} as unknown as LocalAdminClient
 const root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},client}))
 await vi.waitFor(()=>expect(document.body.textContent).toContain('Alice'))
 const environment=globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}
 const previous=environment.IS_REACT_ACT_ENVIRONMENT;environment.IS_REACT_ACT_ENVIRONMENT=true
 try{
  await act(async()=>{([...document.querySelectorAll('button')].find(button=>button.textContent==='禁用账号')!).click()})
  const form=document.querySelector('form[aria-label]')!
  await act(async()=>{const input=form.querySelector<HTMLInputElement>('[aria-label="管理员当前密码"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'administrator test passphrase');input.dispatchEvent(new Event('input',{bubbles:true}))})
  await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
  expect(client.reauthenticate).toHaveBeenCalledOnce()
  expect(form.querySelector<HTMLInputElement>('[aria-label="管理员当前密码"]')?.value).toBe('')
  await act(async()=>finish())
 }finally{await act(async()=>root.unmount());environment.IS_REACT_ACT_ENVIRONMENT=previous}
})

test('password setup clears typed credentials before the pending request completes',async()=>{
 const {act}=await import('react')
 let finish!:()=>void
 const redeem=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}))
 const root=await mount(h(PasswordActionForm,{onClose:()=>{},client:{redeem} as unknown as LocalAdminClient}))
 await vi.waitFor(()=>expect(document.querySelector('form')).not.toBeNull())
 const environment=globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}
 const previous=environment.IS_REACT_ACT_ENVIRONMENT;environment.IS_REACT_ACT_ENVIRONMENT=true
 try{
  const form=document.querySelector('form')!
  await act(async()=>{for(const [name,value] of [['token','x'.repeat(43)],['password','new reset test passphrase'],['confirm','new reset test passphrase']]){const input=form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}})
  await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
  expect(redeem).toHaveBeenCalledWith('x'.repeat(43),'new reset test passphrase')
  expect([...form.querySelectorAll<HTMLInputElement>('input')].filter(input=>input.name).every(input=>input.value==='')).toBe(true)
  await act(async()=>finish())
 }finally{await act(async()=>root.unmount());environment.IS_REACT_ACT_ENVIRONMENT=previous}
})

test('switching from a dirty new-user form preserves the draft unless discard is confirmed and clears the close guard after discard',async()=>{
 const client={list:vi.fn(async()=>({users:[{id:'target',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null}))} as unknown as LocalAdminClient
 let guard:(()=>boolean)|null=null
 const root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},onCloseGuardChange:value=>{guard=value},client}))
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 const button=(label:string)=>[...document.querySelectorAll('button')].find(element=>element.textContent===label)!
 try{
  button('新建用户').click()
  await vi.waitFor(()=>expect(document.querySelector('input[name=username]')).not.toBeNull())
  const username=document.querySelector<HTMLInputElement>('input[name=username]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(username,'unsaved-member');username.dispatchEvent(new Event('input',{bubbles:true}))
  await vi.waitFor(()=>expect(guard?.()).toBe(false));confirm.mockClear()
  button('编辑角色').click()
  await vi.waitFor(()=>expect(confirm).toHaveBeenCalledOnce())
  expect(document.querySelector<HTMLInputElement>('input[name=username]')?.value).toBe('unsaved-member')
  expect(document.querySelector('form[aria-label="确认用户操作"]')).toBeNull()
  confirm.mockReturnValue(true);button('编辑角色').click()
  await vi.waitFor(()=>expect(document.querySelector('form[aria-label="确认用户操作"]')).not.toBeNull())
  button('取消').click()
  await vi.waitFor(()=>expect(document.querySelector('form')).toBeNull())
  confirm.mockClear();expect(guard?.()).toBe(true);expect(confirm).not.toHaveBeenCalled()
 }finally{confirm.mockRestore();root.unmount()}
})

test('changing operations keeps the one-time code until the administrator confirms it was recorded',async()=>{
 const client={list:vi.fn(async()=>({users:[{id:'target',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}],nextCursor:null})),reauthenticate:vi.fn(async()=>{}),issue:vi.fn(async()=>({action:{token:'a'.repeat(43),purpose:'reset',expiresAt:'later'}}))} as unknown as LocalAdminClient
 const root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},client}))
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 const button=(label:string)=>[...document.querySelectorAll('button')].find(element=>element.textContent===label)!
 try{
  button('重置密码').click();await vi.waitFor(()=>expect(document.querySelector('form[aria-label]')).not.toBeNull())
  document.querySelector('form[aria-label]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
  await vi.waitFor(()=>expect(document.querySelector('[aria-label="一次性码"]')).not.toBeNull())
  const reload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(reload);expect(reload.defaultPrevented).toBe(true);expect(confirm).not.toHaveBeenCalled()
  button('编辑角色').click();await vi.waitFor(()=>expect(confirm).toHaveBeenCalledOnce())
  expect(document.querySelector<HTMLInputElement>('[aria-label="一次性码"]')?.value).toBe('a'.repeat(43))
  expect(document.querySelector('form[aria-label]')).toBeNull()
  confirm.mockReturnValue(true);button('编辑角色').click();await vi.waitFor(()=>expect(document.querySelector('form[aria-label]')).not.toBeNull())
  expect(document.querySelector('[aria-label="一次性码"]')).toBeNull()
 }finally{confirm.mockRestore();root.unmount()}
})

test('HTTP 408 fences admin writes and browser reload until a successful explicit refresh',async()=>{
 let fail!:(reason:unknown)=>void
 const client={list:vi.fn(async()=>({users:[],nextCursor:null})),reauthenticate:vi.fn(async()=>{}),create:vi.fn(()=>new Promise((_resolve,reject)=>{fail=reject}))} as unknown as LocalAdminClient
 const root=await mount(h(LocalAdminPanel,{currentUserId:'me',onClose:()=>{},onSessionRotated:()=>{},client}))
 const confirm=vi.spyOn(window,'confirm')
 const button=(label:string)=>[...document.querySelectorAll('button')].find(element=>element.textContent===label)!
 const protectedReload=()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented}
 try{
  button('新建用户').click();await vi.waitFor(()=>expect(document.querySelector('input[name=username]')).not.toBeNull())
  const username=document.querySelector<HTMLInputElement>('input[name=username]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(username,'new-member');username.dispatchEvent(new Event('input',{bubbles:true}))
  await vi.waitFor(()=>expect(protectedReload()).toBe(true))
  document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(document.querySelector('form[aria-label]')).not.toBeNull())
  document.querySelector('form[aria-label]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(client.create).toHaveBeenCalledOnce())
  expect(protectedReload()).toBe(true)
  fail(Object.assign(new Error('timeout'),{status:408}))
  await vi.waitFor(()=>expect(document.body.textContent).toContain('上次操作结果未确认'))
  expect(button('新建用户').disabled).toBe(true)
  expect(protectedReload()).toBe(true);expect(client.create).toHaveBeenCalledOnce();expect(confirm).not.toHaveBeenCalled()
  button('刷新列表').click();await vi.waitFor(()=>expect(button('新建用户').disabled).toBe(false))
  expect(protectedReload()).toBe(false)
 }finally{confirm.mockRestore();root.unmount()}
})
