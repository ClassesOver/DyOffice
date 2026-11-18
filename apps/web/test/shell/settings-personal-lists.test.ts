import {test,expect,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LocalSessionsPanel} from '../../src/shell/LocalSessionsPanel'
import {UserSkillsPanel} from '../../src/shell/UserSkillsPanel'
import {createUserSkillsClient} from '../../src/shell/user-skills-client'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const button=(name:string)=>document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!
test('all active sessions remain reachable in bounded pages and confirmation blocks paging',async()=>{
 document.body.innerHTML='<div id="sessions-paged"></div>';const root=createRoot(document.getElementById('sessions-paged')!)
 const rows=Array.from({length:12},(_,i)=>({id:`session-${i}`,current:i===0,createdAt:'2026-11-16T00:00:00Z',lastSeenAt:'2026-11-16T01:00:00Z',expiresAt:'2026-12-17T00:00:00Z'}))
 const revoke=vi.fn()
 try{
  await act(async()=>root.render(h(LocalSessionsPanel,{client:{listPage:async({after})=>{const start=after?Number(after):0;return {sessions:rows.slice(start,start+5),nextCursor:start+5<rows.length?String(start+5):null}},list:async()=>rows,revoke,revokeOthers:vi.fn()},onCurrentRevoked:()=>{}})))
  expect(document.querySelectorAll('[data-session-id]')).toHaveLength(5)
  const seen:string[]=[]
  for(let page=0;page<3;page++){seen.push(...[...document.querySelectorAll('[data-session-id]')].map(row=>row.getAttribute('data-session-id')!));if(page<2)await act(async()=>button('下一页登录会话').click())}
  expect(seen).toEqual(rows.map(row=>row.id))
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-session-id] button')!.click())
  expect(button('上一页登录会话').disabled).toBe(true)
  expect(revoke).not.toHaveBeenCalled()
 }finally{await act(async()=>root.unmount())}
})
test('all personal skills are reachable through the same pager without catalog or account data truncation',async()=>{
 document.body.innerHTML='<div id="skills-paged"></div>';const root=createRoot(document.getElementById('skills-paged')!)
 const rows=Array.from({length:19},(_,i)=>({name:`word-${i}`,description:'Word report'}))
 const request=vi.fn(async()=>rows as never)
 try{
  await act(async()=>root.render(h(UserSkillsPanel,{client:createUserSkillsClient(request)})))
  const seen:string[]=[]
  for(let page=0;page<4;page++){
   const visible=[...document.querySelectorAll('.personal-skills-owned [data-row-key]')].map(row=>row.getAttribute('data-row-key')!)
   expect(visible.length).toBeLessThanOrEqual(6);seen.push(...visible)
   if(page<3)await act(async()=>button('下一页个人技能').click())
  }
  expect(seen).toEqual(rows.map(row=>row.name))
  expect(request).toHaveBeenCalledTimes(1)
  expect(button('下一页个人技能').disabled).toBe(true)
  expect(document.querySelector('[aria-label="办公技能目录分页"]')).not.toBeNull()
 }finally{await act(async()=>root.unmount())}
})
