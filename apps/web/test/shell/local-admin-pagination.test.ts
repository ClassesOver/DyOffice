import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {LocalAdminPanel} from '../../src/shell/LocalAdminPanel'
import type {LocalAdminClient} from '../../src/shell/local-admin-client'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root|undefined
const user=(id:string)=>({id,username:id,displayName:id,status:'active',roles:['personal'],requiresPasswordReset:false})
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!
async function click(text:string){await act(async()=>button(text).click())}
async function mount(list:LocalAdminClient['list']){document.body.innerHTML='<div id="admin-pages"></div>';root=createRoot(document.getElementById('admin-pages')!);await act(async()=>root!.render(h(LocalAdminPanel,{client:{list} as LocalAdminClient,currentUserId:'me',onClose(){},onSessionRotated(){}})))}
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML='';vi.restoreAllMocks()})
test('cursor navigation replaces rather than accumulates rows, supports previous, and refresh returns to first page',async()=>{
 const list=vi.fn(async(after?:string)=>after?{users:[user('second-page')],nextCursor:null}:{users:[user('first-page')],nextCursor:'cursor-one'})
 await mount(list);await click('下一页')
 expect(document.querySelector('[data-row-key="first-page"]')).toBeNull()
 expect(document.querySelector('[data-row-key="second-page"]')).not.toBeNull()
 expect(document.body.textContent).toContain('第 2 页')
 expect(button('下一页').disabled).toBe(true)
 await click('上一页');expect(document.querySelector('[data-row-key="first-page"]')).not.toBeNull()
 await click('下一页');await click('刷新列表')
 expect(button('上一页').disabled).toBe(true)
 expect(document.querySelector('[data-row-key="second-page"]')).toBeNull()
 expect(list.mock.calls.map(args=>args[0])).toEqual([undefined,'cursor-one',undefined,'cursor-one',undefined])
 expect(document.querySelector('[aria-label="搜索当前页成员"]')).not.toBeNull()
})
test('failed next page leaves page identity, rows and cursor available for explicit retry',async()=>{
 let fail=true
 const list=vi.fn(async(after?:string)=>{if(after&&fail)throw Error('page failed');return after?{users:[user('second-page')],nextCursor:null}:{users:[user('first-page')],nextCursor:'cursor-one'}})
 await mount(list);await click('下一页')
 expect(document.body.textContent).toContain('page failed');expect(document.body.textContent).toContain('第 1 页')
 expect(document.querySelector('[data-row-key="first-page"]')).not.toBeNull()
 expect(button('上一页').disabled).toBe(true)
 fail=false;await click('下一页');expect(document.body.textContent).toContain('第 2 页')
 expect(document.querySelector('[data-row-key="first-page"]')).toBeNull()
})
test('pending page fetch locks both directions and prevents same-turn duplicate navigation',async()=>{
 let resolve!:(value:{users:ReturnType<typeof user>[];nextCursor:null})=>void
 const list=vi.fn(async(after?:string)=>after?new Promise<{users:ReturnType<typeof user>[];nextCursor:null}>(yes=>{resolve=yes}):{users:[user('first-page')],nextCursor:'cursor-one'})
 await mount(list)
 await act(async()=>{button('下一页').click();button('下一页').click()})
 expect(list).toHaveBeenCalledTimes(2);expect(button('上一页').disabled).toBe(true);expect(button('下一页').disabled).toBe(true)
 await act(async()=>resolve({users:[user('second-page')],nextCursor:null}))
 expect(document.body.textContent).toContain('第 2 页')
})
test('failed previous-page read does not clear the visible page or rewind its cursor identity',async()=>{
 let firstReads=0
 const list=vi.fn(async(after?:string)=>{if(!after&&++firstReads>1)throw Error('previous page failed');return after?{users:[user('second-page')],nextCursor:null}:{users:[user('first-page')],nextCursor:'cursor-one'}})
 await mount(list);await click('下一页');await click('上一页')
 expect(document.body.textContent).toContain('previous page failed')
 expect(document.body.textContent).toContain('第 2 页')
 expect(document.querySelector('[data-row-key="second-page"]')).not.toBeNull()
 expect(button('上一页').disabled).toBe(false)
})
test('unsaved new-account fields keep page navigation disabled without discarding the draft',async()=>{
 const list=vi.fn(async()=>({users:[user('first-page')],nextCursor:'cursor-one'}))
 await mount(list);await click('新建用户')
 await act(async()=>{const input=document.querySelector<HTMLInputElement>('[aria-label="新用户名"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'unsaved-person');input.dispatchEvent(new Event('input',{bubbles:true}))})
 expect(button('下一页').disabled).toBe(true)
 await click('下一页');expect(list).toHaveBeenCalledTimes(1)
 expect(document.querySelector<HTMLInputElement>('[aria-label="新用户名"]')?.value).toBe('unsaved-person')
})
