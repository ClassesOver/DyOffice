import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {LoginHistoryPanel} from '../../src/shell/LoginHistoryPanel'
test('history shows only fixed outcome/time labels, and failures clear stale records without claiming empty history',async()=>{
 document.body.innerHTML='<div id="history-test"></div>';const root=createRoot(document.querySelector('#history-test')!);let fail=false
 root.render(h(LoginHistoryPanel,{client:{list:async()=>{if(fail)throw new Error('private credential detail');return [{occurredAt:'2026-11-16T00:00:00Z',outcome:'success'}]}}}))
 try{await vi.waitFor(()=>expect(document.querySelector('[data-history-event]')?.textContent).toContain('登录成功'));fail=true;document.querySelector<HTMLButtonElement>('button')!.click();await vi.waitFor(()=>expect(document.querySelector('[role=alert]')).not.toBeNull());expect(document.querySelector('[data-history-event]')).toBeNull();expect(document.body.textContent).not.toContain('private credential detail');expect(document.body.textContent).not.toContain('暂无可显示')}finally{root.unmount()}
})
test('a late read after unmount cannot populate the newly mounted history',async()=>{
 document.body.innerHTML='<div id="history-test"></div>';let finish!:(x:any)=>void;let root=createRoot(document.querySelector('#history-test')!);root.render(h(LoginHistoryPanel,{client:{list:()=>new Promise(r=>{finish=r})}}));await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));root.unmount();root=createRoot(document.querySelector('#history-test')!);root.render(h(LoginHistoryPanel,{client:{list:async()=>[]}}));try{await vi.waitFor(()=>expect(document.body.textContent).toContain('暂无可显示'));finish([{occurredAt:'2026-11-16T00:00:00Z',outcome:'success'}]);await new Promise(r=>setTimeout(r,0));expect(document.querySelector('[data-history-event]')).toBeNull()}finally{root.unmount()}
})
