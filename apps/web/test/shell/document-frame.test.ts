import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {DocumentFrame} from '../../src/shell/DocumentFrame'
import type {DocumentCloseGuard} from '../../src/shell/document-tabs'
let root:Root,host:HTMLDivElement,guard:DocumentCloseGuard
const file={id:'a',name:'Test.docx',format:'docx' as const,src:'/native-docx/?fileId=a'}
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
async function mount(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(h(DocumentFrame,{file,registerGuard:(_id,value)=>{if(value)guard=value}})))}
async function load(mime='application/json',body=JSON.stringify({type:'about:blank',title:'Service Unavailable',status:503}),scripts=0){
 const frame=host.querySelector('iframe')!,doc={contentType:mime,URL:new URL(file.src,window.location.href).href,scripts:{length:scripts},body:{textContent:body}}
 Object.defineProperty(frame,'contentDocument',{configurable:true,value:doc})
 await act(async()=>frame.dispatchEvent(new Event('load')))
 return frame
}
for(const mime of ['application/json','application/problem+json'])test(`${mime} entry failure can retry or close before an editor starts`,async()=>{
 await mount();await load(mime)
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('编辑器加载失败')
 expect(await guard()).toBe(true)
 const previous=host.querySelector('iframe')!
 await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click())
 expect(host.querySelector('iframe')).not.toBe(previous)
 const alert=vi.spyOn(window,'alert').mockImplementation(()=>{})
 expect(await guard()).toBe(false);expect(alert).toHaveBeenCalledOnce()
 await load('text/html','Editor',1)
 const editor=host.querySelector('iframe')!.contentWindow!
 Object.assign(editor,{dyofficeEditorCanClose:vi.fn(async()=>true),dyofficeEditorDispose:vi.fn(async()=>true)})
 expect(await guard()).toBe(true)
 expect(editor.dyofficeEditorDispose).toHaveBeenCalledOnce()
})
test('HTML startup followed by JSON never unlocks the editor guard',async()=>{
 await mount();vi.spyOn(window,'alert').mockImplementation(()=>{})
 await load('text/html','Editor',1);await load()
 expect(host.querySelector('[role="alert"]')).toBeNull();expect(await guard()).toBe(false)
})
test.each(['invalid','scripts','lifecycle'])('unconfirmed %s failure stays guarded',async kind=>{
 await mount();vi.spyOn(window,'alert').mockImplementation(()=>{})
 if(kind==='lifecycle')Object.assign(host.querySelector('iframe')!.contentWindow!,{dyofficeEditorCanClose:()=>false,dyofficeEditorDispose:()=>true})
 await load('application/json',kind==='invalid'?'{}':undefined,kind==='scripts'?1:0)
 expect(host.querySelector('[role="alert"]')).toBeNull();expect(await guard()).toBe(false)
})

test('a lifecycle installed after the error load cannot be bypassed by the prior failure classification',async()=>{
 await mount();await load()
 const canClose=vi.fn(()=>false),dispose=vi.fn(()=>true)
 Object.assign(host.querySelector('iframe')!.contentWindow!,{dyofficeEditorCanClose:canClose,dyofficeEditorDispose:dispose})
 expect(await guard()).toBe(false);expect(canClose).toHaveBeenCalledOnce();expect(dispose).not.toHaveBeenCalled()
})

test('retry cannot replace an editor that started after its initial error response',async()=>{
 await mount();await load()
 const previous=host.querySelector('iframe')!
 Object.assign(previous.contentWindow!,{dyofficeEditorCanClose:()=>false,dyofficeEditorDispose:()=>false})
 await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click())
 expect(host.querySelector('iframe')).toBe(previous)
 expect(host.querySelector('[role="alert"]')).toBeNull()
 expect(await guard()).toBe(false)
})

test('draft-copy capability reads current Shell recovery state and expires on unmount',async()=>{
 let active=true
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root.render(h(DocumentFrame,{file,registerGuard:()=>{},sessionActive:()=>active})))
 const frame=host.querySelector('iframe')! as HTMLIFrameElement&{dyofficeDraftCopySessionActive:()=>boolean}
 expect(frame.dyofficeDraftCopySessionActive()).toBe(true)
 active=false;expect(frame.dyofficeDraftCopySessionActive()).toBe(false)
 active=true;await act(async()=>root.render(null))
 expect(frame.dyofficeDraftCopySessionActive()).toBe(false)
})
