import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {DocumentFrame} from '../../src/shell/DocumentFrame'
let root:Root,host:HTMLDivElement
const file={id:'a',name:'季度报告.xlsx',format:'xlsx' as const,src:'/native-xlsx/?fileId=a'}
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers()})
async function mount(){Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(h(DocumentFrame,{file,registerGuard:()=>{}})))}
async function report(state:string,source:MessageEventSource|null=host.querySelector('iframe')!.contentWindow,origin=location.origin){await act(async()=>window.dispatchEvent(new MessageEvent('message',{source,origin,data:{type:'dyoffice-document-loading',state}})))}
test('keeps loading until the document is ready, ignores unrelated frames and origins',async()=>{
 await mount()
 expect(host.querySelector('.document-loading')?.textContent).toContain(file.name)
 await act(async()=>host.querySelector('iframe')!.dispatchEvent(new Event('load')))
 expect(host.querySelector('.document-loading')).not.toBeNull()
 await report('ready',window);await report('ready',host.querySelector('iframe')!.contentWindow,'https://other.example')
 expect(host.querySelector('.document-loading')).not.toBeNull()
 await report('rendering');expect(host.textContent).toContain('正在准备页面')
 await report('ready');expect(host.querySelector('.document-loading')).toBeNull()
})
test('slow loading shows a useful hint without inventing percentage progress',async()=>{
 vi.useFakeTimers();await mount()
 await act(async()=>vi.advanceTimersByTime(8000))
 expect(host.textContent).toContain('仍在加载')
 expect(host.textContent).not.toContain('%')
})
test('retry respects the editor close guard and resets loading only after disposal',async()=>{
 await mount();const frame=host.querySelector('iframe')!,editor=frame.contentWindow!
 let allowed=false
 Object.assign(editor,{dyofficeEditorCanClose:async()=>allowed,dyofficeEditorDispose:async()=>true})
 await report('error')
 const retry=()=>host.querySelector<HTMLButtonElement>('.document-loading button')!
 await act(async()=>retry().click());expect(host.querySelector('iframe')).toBe(frame)
 allowed=true;await act(async()=>retry().click())
 expect(host.querySelector('iframe')).not.toBe(frame)
 expect(host.textContent).toContain('正在读取文档')
})

test('opening and switching tabs retains each iframe and its own loading state',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const second={...file,id:'b',name:'第二份报告.xlsx',src:'/native-xlsx/?fileId=b'}
 const registerGuard=()=>{}
 async function tabs(active:string,includeSecond=true){await act(async()=>root.render(h('div',null,
  h('section',{key:file.id,hidden:active!==file.id},h(DocumentFrame,{file,registerGuard})),
  includeSecond&&h('section',{key:second.id,hidden:active!==second.id},h(DocumentFrame,{file:second,registerGuard})),
 )))}
 await tabs('a',false)
 const firstFrame=host.querySelector('iframe')!
 await report('ready',firstFrame.contentWindow)
 await tabs('b')
 const secondFrame=host.querySelectorAll('iframe')[1]
 expect(host.querySelector('iframe')).toBe(firstFrame)
 expect(host.querySelectorAll('section')[0].querySelector('.document-loading')).toBeNull()
 await report('rendering',secondFrame.contentWindow)
 await tabs('a')
 expect(host.querySelectorAll('section')[0].querySelector('.document-loading')).toBeNull()
 expect(host.querySelectorAll('section')[1].querySelector('.document-loading')).not.toBeNull()
 await report('ready',secondFrame.contentWindow)
 await tabs('b')
 expect(host.querySelectorAll('iframe')[1]).toBe(secondFrame)
 expect(host.querySelectorAll('.document-loading')).toHaveLength(0)
})

test('iframe load recovers readiness reported before the parent message listener',async()=>{
 await mount()
 const frame=host.querySelector('iframe')!
 const childDocument=document.implementation.createHTMLDocument()
 childDocument.documentElement.dataset.documentLoading='ready'
 Object.defineProperty(frame,'contentDocument',{configurable:true,value:childDocument})
 await act(async()=>frame.dispatchEvent(new Event('load')))
 expect(host.querySelector('.document-loading')).toBeNull()
})
