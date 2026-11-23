import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {LocalAdminPanel} from '../../src/shell/LocalAdminPanel'
import type {LocalAdminClient} from '../../src/shell/local-admin-client'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root|undefined
const alice={id:'alice',username:'alice',displayName:'Alice',status:'active',roles:['personal'],requiresPasswordReset:false}
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!
async function click(text:string){await act(async()=>button(text).click())}
async function fill(label:string,value:string){await act(async()=>{const input=document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
async function submit(){await act(async()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))}
async function mount(client:Partial<LocalAdminClient>={}){document.body.innerHTML='<div id="admin-experience"></div>';root=createRoot(document.getElementById('admin-experience')!);await act(async()=>root!.render(h(LocalAdminPanel,{client:{list:async()=>({users:[alice],nextCursor:null}),...client} as LocalAdminClient,currentUserId:'me',onClose(){},onSessionRotated(){}})))}
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML='';vi.restoreAllMocks()})
test('current-page search trims whitespace and empty results offer a reset without refetching',async()=>{
 const list=vi.fn(async()=>({users:[alice],nextCursor:null}));await mount({list})
 await fill('搜索当前页成员','  ALICE  ')
 expect(document.querySelector('[data-row-key="alice"]')).not.toBeNull()
 await fill('搜索当前页成员','nobody')
 expect(document.querySelector('[data-row-key="alice"]')).toBeNull()
 await click('清除筛选')
 expect(document.querySelector<HTMLInputElement>('[aria-label="搜索当前页成员"]')?.value).toBe('')
 expect(document.querySelector('[data-row-key="alice"]')).not.toBeNull();expect(list).toHaveBeenCalledTimes(1)
})
test('invalid new usernames stay in the draft with an accessible explanation before password verification',async()=>{
 await mount();await click('新建用户');await fill('新用户名','invalid name');await submit()
 const input=document.querySelector<HTMLInputElement>('[aria-label="新用户名"]')!
 expect(input?.value).toBe('invalid name');expect(input?.getAttribute('aria-invalid')).toBe('true')
 expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toContain('3–64')
 expect(document.querySelector('form[aria-label="确认用户操作"]')).toBeNull()
 await fill('新用户名','  New.Member  ');await submit()
 expect(document.querySelector('form[aria-label="确认用户操作"]')?.textContent).toContain('new.member')
})
test('list refresh announces pending and completed states without calling it a user mutation',async()=>{
 let finish!:(value:{users:typeof alice[];nextCursor:null})=>void
 const list=vi.fn().mockResolvedValueOnce({users:[alice],nextCursor:null}).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 await mount({list});await click('刷新列表')
 expect(document.querySelector('[aria-label="用户管理"]')?.getAttribute('aria-busy')).toBe('true')
 expect(document.querySelector('[role="status"]')?.textContent).toContain('正在加载成员')
 await act(async()=>finish({users:[alice],nextCursor:null}))
 expect(document.querySelector('[role="status"]')?.textContent).toContain('成员列表已刷新')
})
test('successful account mutation identifies the target and clears stale success when another action begins',async()=>{
 await mount({reauthenticate:async()=>undefined as never,setStatus:async()=>({user:{...alice,status:'disabled'}})})
 await click('禁用账号');await fill('管理员当前密码','test password');await submit()
 expect(document.querySelector('[role="status"]')?.textContent).toContain('已禁用账号：alice')
 await click('重置密码')
 expect(document.querySelector('[role="status"]')).toBeNull()
})

test('native management controls filter status and preserve semantic table rows without library wrappers',async()=>{
 const pending={...alice,id:'pending',username:'pending',status:'pending'}
 const list=vi.fn(async()=>({users:[alice,pending],nextCursor:null}))
 await mount({list})
 expect(document.querySelector('.local-admin-panel .ant-table,.local-admin-panel .ant-select,.local-admin-panel .ant-btn')).toBeNull()
 expect(document.querySelector('table thead th')?.getAttribute('scope')).toBe('col')
 const select=document.querySelector<HTMLSelectElement>('select[aria-label="账号状态筛选"]')!
 await act(async()=>{select.value='pending';select.dispatchEvent(new Event('change',{bubbles:true}))})
 expect(document.querySelector('tbody tr[data-row-key="alice"]')).toBeNull()
 expect(document.querySelector('tbody tr[data-row-key="pending"]')).not.toBeNull()
 expect(list).toHaveBeenCalledOnce()
 await click('编辑角色')
 const checkbox=document.querySelector<HTMLInputElement>('input[name=role][value=operator]')!
 expect(checkbox.type).toBe('checkbox')
 expect(checkbox.closest('label')?.textContent).toBe('运维人员')
 const password=document.querySelector<HTMLInputElement>('[aria-label="管理员当前密码"]')!
 expect(password.type).toBe('password')
 expect(password.autocomplete).toBe('current-password')
})
