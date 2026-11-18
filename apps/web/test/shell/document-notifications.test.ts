import {createElement} from 'react'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {DocumentNotifications} from '../../src/editors/document-notifications'
let root:ReturnType<typeof createRoot>|undefined
let container:HTMLDivElement
function render(items:any[]){if(!root){container=document.createElement('div');document.body.append(container);root=createRoot(container)}act(()=>root!.render(createElement(DocumentNotifications,{items})));return container}
afterEach(()=>{act(()=>root?.unmount());root=undefined;container?.remove();vi.useRealTimers()})
it('collapses informational notices, retains an accessible entry, and reopens them',()=>{
 vi.useFakeTimers();const node=render([{id:'connection',level:'info',title:'版本同步',message:'正在恢复连接'}])
 expect(node.querySelector('.document-notification')).not.toBeNull()
 act(()=>vi.advanceTimersByTime(6000))
 expect(node.querySelector('.document-notification')).toBeNull()
 act(()=>node.querySelector<HTMLButtonElement>('.document-notification-trigger')!.click())
 expect(node.textContent).toContain('正在恢复连接')
})
it('keeps actionable errors until dismissed and clears resolved messages',()=>{
 vi.useFakeTimers();const retry=vi.fn();const node=render([{id:'save',level:'error',title:'保存失败',message:'请重试',actions:createElement('button',{onClick:retry},'重试')}])
 act(()=>vi.advanceTimersByTime(60000));expect(node.textContent).toContain('请重试')
 act(()=>Array.from(node.querySelectorAll('button')).find(b=>b.textContent==='重试')!.click());expect(retry).toHaveBeenCalledOnce()
 act(()=>node.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!.click());expect(node.querySelector('.document-notification')).toBeNull()
 render([]);expect(node.querySelector('.document-notification-trigger')).toBeNull()
})
