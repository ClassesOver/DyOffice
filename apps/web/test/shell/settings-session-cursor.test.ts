import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {LocalSessionsPanel} from '../../src/shell/LocalSessionsPanel'
let root:Root
const row=(id:string,current=false)=>({id,current,createdAt:'2026-11-16T00:00:00Z',lastSeenAt:'2026-11-16T01:00:00Z',expiresAt:'2026-12-17T00:00:00Z'})
const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name||b.getAttribute('aria-label')===name)!
afterEach(async()=>{await act(async()=>root?.unmount());document.body.innerHTML=''})
async function mount(client:any){vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);document.body.innerHTML='<div id="sessions"></div>';root=createRoot(document.getElementById('sessions')!);await act(async()=>root.render(h(LocalSessionsPanel,{client,onCurrentRevoked:()=>{}})))}
test('sessions browse real cursor pages without fetching the full set, retain failed page and retry its cursor',async()=>{
 let failed=true;const list=vi.fn(async()=>[row('full')]);const listPage=vi.fn(async({after}:any)=>{if(after&&failed)throw Error('page failed');return {sessions:[row(after?'two':'one',!after)],nextCursor:after?null:'cursor-one'}})
 await mount({list,listPage,revoke:vi.fn(),revokeOthers:vi.fn()})
 expect(list).not.toHaveBeenCalled();expect(listPage).toHaveBeenCalledWith({limit:5,after:undefined})
 await act(async()=>button('下一页登录会话').click())
 expect(document.querySelector('[data-session-id="one"]')).not.toBeNull()
 expect(document.querySelector('.settings-list-page-status')?.textContent).toBe('第 1 页')
 failed=false;await act(async()=>button('下一页登录会话').click())
 expect(listPage.mock.calls.at(-1)?.[0]).toEqual({limit:5,after:'cursor-one'})
 expect(document.querySelector('[data-session-id="two"]')).not.toBeNull()
 await act(async()=>button('上一页登录会话').click());expect(listPage.mock.calls.at(-1)?.[0]).toEqual({limit:5,after:undefined})
})
test('uncertain revoke requires explicit full reconciliation before cursor reload and no partial-page unlock',async()=>{
 let failReconcile=true;const list=vi.fn(async()=>{if(failReconcile)throw Error('unavailable');return [row('current',true)]})
 const listPage=vi.fn(async()=>({sessions:[row('current',true),row('other')],nextCursor:'later'})),revoke=vi.fn(async()=>{throw Error('lost')})
 await mount({list,listPage,revoke,revokeOthers:vi.fn()})
 await act(async()=>button('撤销此会话').click());await act(async()=>button('确认撤销').click())
 expect(button('下一页登录会话').disabled).toBe(true)
 await act(async()=>button('刷新会话列表').click())
 expect(list).toHaveBeenCalledTimes(1);expect(listPage).toHaveBeenCalledTimes(1)
 expect(button('下一页登录会话').disabled).toBe(true)
 failReconcile=false;await act(async()=>button('刷新会话列表').click())
 expect(list).toHaveBeenCalledTimes(2);expect(listPage).toHaveBeenCalledTimes(2)
 expect(button('下一页登录会话').disabled).toBe(false);expect(revoke).toHaveBeenCalledTimes(1)
})
test('confirmed bulk revoke reloads the first cursor page even when other sessions are off-page',async()=>{
 let done=false;const revokeOthers=vi.fn(async()=>{done=true}),list=vi.fn()
 const listPage=vi.fn(async()=>({sessions:[row('current',true)],nextCursor:done?null:'later'}))
 await mount({list,listPage,revoke:vi.fn(),revokeOthers})
 expect(button('撤销所有其他会话').disabled).toBe(false)
 await act(async()=>button('撤销所有其他会话').click());expect(button('下一页登录会话').disabled).toBe(true)
 await act(async()=>button('确认撤销').click())
 expect(revokeOthers).toHaveBeenCalledTimes(1);expect(listPage).toHaveBeenCalledTimes(2);expect(list).not.toHaveBeenCalled()
 expect(document.querySelector('.settings-list-page-status')?.textContent).toBe('第 1 页')
 expect(button('下一页登录会话').disabled).toBe(true)
})
test('page requests are single-flight and preserve revocation confirmation boundaries',async()=>{
 let release!:(value:unknown)=>void;const listPage=vi.fn(async({after}:any)=>after?new Promise(resolve=>{release=resolve}):({sessions:[row('one')],nextCursor:'later'}))
 await mount({list:vi.fn(),listPage,revoke:vi.fn(),revokeOthers:vi.fn()})
 await act(async()=>{button('下一页登录会话').click();button('下一页登录会话').click()})
 expect(listPage).toHaveBeenCalledTimes(2);expect(button('下一页登录会话').disabled).toBe(true);expect(button('撤销此会话').disabled).toBe(true)
 await act(async()=>release({sessions:[row('two')],nextCursor:null}))
 expect(document.querySelector('[data-session-id="two"]')).not.toBeNull()
})
test('confirmed revoke with a failed follow-up read is not reported as uncertain and never resent',async()=>{
 let done=false;const revoke=vi.fn(async()=>{done=true}),listPage=vi.fn(async()=>{if(done)throw Error('read failed');return {sessions:[row('other')],nextCursor:null}})
 await mount({list:vi.fn(),listPage,revoke,revokeOthers:vi.fn()})
 await act(async()=>button('撤销此会话').click());await act(async()=>button('确认撤销').click())
 expect(document.body.textContent).toContain('会话已撤销，但列表刷新失败')
 expect(document.body.textContent).not.toContain('撤销结果未确认')
 await act(async()=>button('刷新会话列表').click());expect(revoke).toHaveBeenCalledTimes(1)
})
