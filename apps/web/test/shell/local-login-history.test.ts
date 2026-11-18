import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LoginHistoryPanel} from '../../src/shell/LoginHistoryPanel'
test('history shows only fixed outcome/time labels, and failures clear stale records without claiming empty history',async()=>{
 document.body.innerHTML='<div id="history-test"></div>';const root=createRoot(document.querySelector('#history-test')!);let fail=false
 root.render(h(LoginHistoryPanel,{client:{listPage:async()=>{if(fail)throw new Error('private credential detail');return {events:[{occurredAt:'2026-11-16T00:00:00Z',outcome:'success'}],nextCursor:null}}}}))
 try{await vi.waitFor(()=>expect(document.querySelector('[data-history-event]')?.textContent).toContain('登录成功'));fail=true;document.querySelector<HTMLButtonElement>('button')!.click();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')).not.toBeNull());expect(document.querySelector('[data-history-event]')).toBeNull();expect(document.body.textContent).not.toContain('private credential detail');expect(document.body.textContent).not.toContain('暂无可显示')}finally{root.unmount()}
})
test('a late read after unmount cannot populate the newly mounted history',async()=>{
 document.body.innerHTML='<div id="history-test"></div>';let finish!:(x:any)=>void;let root=createRoot(document.querySelector('#history-test')!);root.render(h(LoginHistoryPanel,{client:{listPage:()=>new Promise(r=>{finish=r})}}));await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));root.unmount();root=createRoot(document.querySelector('#history-test')!);root.render(h(LoginHistoryPanel,{client:{listPage:async()=>({events:[],nextCursor:null})}}));try{await vi.waitFor(()=>expect(document.body.textContent).toContain('暂无可显示'));finish({events:[{occurredAt:'2026-11-16T00:00:00Z',outcome:'success'}],nextCursor:null});await new Promise(r=>setTimeout(r,0));expect(document.querySelector('[data-history-event]')).toBeNull()}finally{root.unmount()}
})

test('twenty history records are paged five at a time, all remain reachable, and refresh resets the page',async()=>{
 const {act}=await import('react')
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 document.body.innerHTML='<div id="history-paging"></div>'
 const root=createRoot(document.getElementById('history-paging')!)
 const events=Array.from({length:20},(_,index)=>({occurredAt:new Date(Date.UTC(2026,10,16,0,20-index)).toISOString(),outcome:'success' as const}))
 const button=(label:string)=>document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
 try{
  await act(async()=>root.render(h(LoginHistoryPanel,{client:{listPage:async({limit=5,after})=>{const offset=Number(after??0);return {events:events.slice(offset,offset+limit),nextCursor:offset+limit<events.length?String(offset+limit):null}}}})))
  const region=document.querySelector<HTMLElement>('[role="region"][aria-label="登录历史记录"]')!
  expect(region.tabIndex).toBe(0)
  region.focus();expect(document.activeElement).toBe(region)
  expect(button('上一页登录记录').disabled).toBe(true)
  const seen:string[]=[]
  for(let page=0;page<4;page++){
   expect(document.querySelectorAll('[data-history-event]')).toHaveLength(5)
   seen.push(...[...document.querySelectorAll<HTMLTimeElement>('time')].map(time=>time.dateTime))
   expect(document.querySelector('[aria-label="登录记录分页"]')?.textContent).toContain(`第 ${page+1} 页`)
   if(page<3){button('下一页登录记录').focus();expect(document.activeElement).toBe(button('下一页登录记录'));await act(async()=>button('下一页登录记录').click())}
  }
  expect(seen).toEqual(events.map(event=>event.occurredAt))
  expect(button('下一页登录记录').disabled).toBe(true)
  await act(async()=>button('上一页登录记录').click())
  expect(document.querySelector('time')?.dateTime).toBe(events[10].occurredAt)
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='刷新登录历史')!.click())
  expect(document.querySelector('time')?.dateTime).toBe(events[0].occurredAt)
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})

test('cursor history requests every retained page instead of truncating at twenty records',async()=>{
 const {act}=await import('react')
 document.body.innerHTML='<div id="history-cursor"></div>'
 const root=createRoot(document.getElementById('history-cursor')!)
 const events=Array.from({length:31},(_,index)=>({occurredAt:new Date(Date.UTC(2026,10,16,0,40-index)).toISOString(),outcome:'success' as const}))
 const list=vi.fn(async()=>events.slice(0,20)),listPage=vi.fn(async({limit,after}:{limit:number;after?:string})=>{const offset=Number(after??0);return {events:events.slice(offset,offset+limit),nextCursor:offset+limit<events.length?String(offset+limit):null}})
 const next=()=>document.querySelector<HTMLButtonElement>('[aria-label="下一页登录记录"]')!
 try{
  await act(async()=>root.render(h(LoginHistoryPanel,{client:{list,listPage} as any})))
  const seen:string[]=[]
  for(let index=0;index<7;index++){
   seen.push(...[...document.querySelectorAll<HTMLTimeElement>('time')].map(time=>time.dateTime))
   expect(document.querySelector('[aria-label="登录记录分页"]')?.textContent).toContain(`第 ${index+1} 页`)
   if(index<6)await act(async()=>next().click())
  }
  expect(seen).toEqual(events.map(event=>event.occurredAt))
  expect(next().disabled).toBe(true)
  expect(list).not.toHaveBeenCalled()
  expect(listPage).toHaveBeenCalledTimes(7)
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="上一页登录记录"]')!.click())
  expect(document.querySelector('time')?.dateTime).toBe(events[25].occurredAt)
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})

test('identity replacement rejects a late history page and retains the new pending lock',async()=>{
 const {act}=await import('react')
 document.body.innerHTML='<div id="history-identity"></div>'
 const root=createRoot(document.getElementById('history-identity')!)
 let oldFinish!:(value:any)=>void,newFinish!:(value:any)=>void
 const oldClient={listPage:vi.fn(()=>new Promise<any>(resolve=>{oldFinish=resolve}))},newClient={listPage:vi.fn(()=>new Promise<any>(resolve=>{newFinish=resolve}))}
 try{
  await act(async()=>root.render(h(LoginHistoryPanel,{client:oldClient})))
  await act(async()=>root.render(h(LoginHistoryPanel,{client:newClient})))
  await act(async()=>oldFinish({events:[{occurredAt:'2026-11-16T01:00:00Z',outcome:'success'}],nextCursor:null}))
  expect(document.querySelector('time')).toBeNull()
  expect(document.querySelector('[aria-label="登录历史记录"]')?.getAttribute('aria-busy')).toBe('true')
  expect(document.querySelector<HTMLButtonElement>('[aria-label="下一页登录记录"]')?.disabled).toBe(true)
  await act(async()=>newFinish({events:[{occurredAt:'2026-11-16T02:00:00Z',outcome:'failure'}],nextCursor:null}))
  expect(document.querySelector('time')?.dateTime).toBe('2026-11-16T02:00:00Z')
  expect(newClient.listPage).toHaveBeenCalledTimes(1)
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})

test('a pending next page cannot be submitted twice and read failure has an explicit retry',async()=>{
 const {act}=await import('react')
 document.body.innerHTML='<div id="history-pending"></div>'
 const root=createRoot(document.getElementById('history-pending')!)
 let fail!:(reason:Error)=>void
 const event={occurredAt:'2026-11-16T01:00:00Z',outcome:'success' as const}
 const listPage=vi.fn().mockResolvedValueOnce({events:[event],nextCursor:'next'}).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject})).mockResolvedValue({events:[event],nextCursor:null})
 try{
  await act(async()=>root.render(h(LoginHistoryPanel,{client:{listPage}})))
  const next=document.querySelector<HTMLButtonElement>('[aria-label="下一页登录记录"]')!
  await act(async()=>{next.click();next.click()})
  expect(listPage).toHaveBeenCalledTimes(2)
  await act(async()=>fail(new Error('private error')))
  expect(document.querySelector('[role=alert]')).not.toBeNull()
  expect(document.querySelector('time')).toBeNull()
  expect(document.body.textContent).not.toContain('private error')
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='刷新登录历史')!.click())
  expect(document.querySelector('time')?.dateTime).toBe(event.occurredAt)
  expect(listPage).toHaveBeenLastCalledWith({limit:5,after:undefined})
 }finally{await act(async()=>root.unmount());document.body.innerHTML=''}
})
