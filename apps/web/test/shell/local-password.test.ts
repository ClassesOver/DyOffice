import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LocalPasswordForm} from '../../src/shell/LocalPasswordForm'
async function fixture(change:(current:string,next:string)=>Promise<void>,onCloseGuardChange?:(guard:(()=>boolean)|null)=>void){document.body.innerHTML='<div id="password-test"></div>';const root=createRoot(document.querySelector('#password-test')!);root.render(h(LocalPasswordForm,{changePassword:change,reload:vi.fn(),onCloseGuardChange}));await vi.waitFor(()=>expect(document.querySelector('form')).not.toBeNull());const form=document.querySelector('form')!;const fill=(confirmation='violet new lanterns 8246')=>{for(const [name,value] of Object.entries({currentPassword:'violet old lanterns 8246',newPassword:'violet new lanterns 8246',confirmation}))(form.elements.namedItem(name) as HTMLInputElement).value=value};const submit=()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return {root,form,fill,submit}}
test('password confirmation mismatch makes no request and never echoes secrets',async()=>{const change=vi.fn();const f=await fixture(change);try{f.fill('different');f.submit();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('不一致'));expect(change).not.toHaveBeenCalled();expect(document.body.textContent).not.toContain('violet')}finally{f.root.unmount()}})
test('pending form blocks duplicate submit, clears plaintext and reports confirmed rotation',async()=>{let resolve!:()=>void;const change=vi.fn(()=>new Promise<void>(r=>{resolve=r}));const f=await fixture(change);try{f.fill();f.submit();f.submit();expect(change).toHaveBeenCalledTimes(1);expect([...f.form.querySelectorAll('input')].every(i=>i.value==='')).toBe(true);resolve();await vi.waitFor(()=>expect(document.querySelector('[role=status]')?.textContent).toContain('当前会话已更新'));expect(document.body.textContent).not.toContain('violet')}finally{f.root.unmount()}})
test('unknown commit failure prevents a blind retry and does not claim success',async()=>{const change=vi.fn(async()=>{throw new TypeError('private transport detail')});const f=await fixture(change);try{f.fill();f.submit();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('无法确认'));f.submit();expect(change).toHaveBeenCalledTimes(1);expect(document.body.textContent).not.toContain('private transport detail');expect(document.querySelector('[role=status]')).toBeNull()}finally{f.root.unmount()}})
test('rejected current password does not report a change or expose returned error details',async()=>{const change=vi.fn(async()=>{throw Object.assign(new Error('private backend detail'),{status:401})});const f=await fixture(change);try{f.fill();f.submit();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('当前密码'));expect(document.body.textContent).not.toContain('private backend detail');expect(document.querySelector('[role=status]')).toBeNull()}finally{f.root.unmount()}})
test('closing and reopening settings cannot repeat an unknown password write',async()=>{
 const {createLocalShellClient}=await import('../../src/shell/local-client')
 let writes=0
 const client=createLocalShellClient(async path=>{if(String(path).endsWith('/csrf'))return new Response(JSON.stringify({csrfToken:'c'.repeat(43)}));writes++;return new Response('{}')})
 let f=await fixture(client.changePassword)
 try{f.fill();f.submit();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('无法确认'));expect(document.querySelector('[role=status]')).toBeNull();f.root.unmount();f=await fixture(client.changePassword);f.fill();f.submit();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('无法确认'));expect(writes).toBe(1)}finally{f.root.unmount()}
})
test('password controls retain explicit labels, password semantics and autocomplete for password managers',async()=>{
 const f=await fixture(vi.fn())
 try{
  for(const [label,autocomplete] of [['当前密码','current-password'],['新密码','new-password'],['确认新密码','new-password']]){
   const name=[...f.form.querySelectorAll('label')].find(node=>node.textContent===label)!
   const input=document.getElementById(name.htmlFor) as HTMLInputElement
   expect(input.type).toBe('password')
   expect(input.autocomplete).toBe(autocomplete)
   expect(input.required).toBe(true)
  }
 }finally{f.root.unmount()}
})

test('typed password values are cleared while a real input-driven request is pending',async()=>{
 const {act}=await import('react')
 let finish!:()=>void
 const change=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}))
 const f=await fixture(change)
 const environment=globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}
 const previous=environment.IS_REACT_ACT_ENVIRONMENT;environment.IS_REACT_ACT_ENVIRONMENT=true
 try{
  await act(async()=>{
   for(const [name,value] of Object.entries({currentPassword:'current test passphrase',newPassword:'new long test passphrase',confirmation:'new long test passphrase'})){
    const input=f.form.elements.namedItem(name) as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value)
    input.dispatchEvent(new Event('input',{bubbles:true}))
   }
  })
  await act(async()=>{f.submit()})
  expect(change).toHaveBeenCalledOnce()
  expect([...f.form.querySelectorAll('input')].every(input=>input.value==='')).toBe(true)
  await act(async()=>finish())
 }finally{await act(async()=>f.root.unmount());environment.IS_REACT_ACT_ENVIRONMENT=previous}
})

test('password close guard prevents leaving a pending write and confirms an unknown result without exposing credentials',async()=>{
 let guard:(()=>boolean)|null=null,reject!:(error:Error)=>void
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 const f=await fixture(()=>new Promise<void>((_resolve,no)=>{reject=no}),next=>{guard=next})
 try{
  expect(guard?.()).toBe(true)
  f.fill();f.submit()
  expect(guard?.()).toBe(false)
  expect(confirm).not.toHaveBeenCalled()
  reject(new TypeError('unknown'))
  await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('无法确认'))
  expect(guard?.()).toBe(false)
  expect(confirm).toHaveBeenCalledOnce()
  expect(confirm.mock.calls.flat().join('')).not.toContain('violet')
 }finally{f.root.unmount();confirm.mockRestore()}
})
