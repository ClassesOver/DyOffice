import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {DocumentFrame} from '../../src/shell/DocumentFrame'
import type {WorkspaceOpenFrame} from '../../src/editors/browser-document-command'
import type {DocumentCloseGuard} from '../../src/shell/document-tabs'
let root:Root,host:HTMLDivElement,guard:DocumentCloseGuard
const file={id:'a',name:'Test.docx',format:'docx' as const,src:'/native-docx/?fileId=a'}
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks()})
async function mount(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(h(DocumentFrame,{file,registerGuard:(_id,value)=>{if(value)guard=value}})))}

test('only PPTX editor frames receive browser display-capture and fullscreen delegation',async()=>{
 await mount()
 expect(host.querySelector('iframe')?.hasAttribute('allow')).toBe(false)
 const slides={...file,format:'pptx' as const,src:'/native-pptx/?fileId=a'}
 await act(async()=>root.render(h(DocumentFrame,{file:slides,registerGuard:()=>{}})))
 expect(host.querySelector('iframe')?.getAttribute('allow')).toBe('display-capture; fullscreen')
})
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

test('closing the new window while the editor is saving prevents disposal',async()=>{
 await mount()
 let popupOpen=true
 const dispose=vi.fn(()=>true)
 Object.assign(host.querySelector('iframe')!.contentWindow!,{
  dyofficeEditorCanClose:async()=>{await Promise.resolve();popupOpen=false;return true},
  dyofficeEditorDispose:dispose,
 })
 expect(await guard(()=>popupOpen)).toBe(false)
 expect(dispose).not.toHaveBeenCalled()
})

test('a background editor hosting a live audience cannot sleep',async()=>{
 let sleepGuard:DocumentCloseGuard|undefined
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root.render(h(DocumentFrame,{file,registerGuard:()=>{},sessionActive:()=>true,
  registerSleepGuard:(_id,guard)=>{sleepGuard=guard??undefined}})))
 const editor=host.querySelector('iframe')!.contentWindow!
 const canSleep=vi.fn(()=>false),dispose=vi.fn(()=>true)
 Object.assign(editor,{dyofficeEditorCanSleep:canSleep,dyofficeEditorDispose:dispose})
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{source:editor,origin:location.origin,data:{type:'dyoffice-document-loading',state:'ready'}})))
 expect(await sleepGuard?.(()=>true)).toBe(false)
 expect(dispose).not.toHaveBeenCalled()
 canSleep.mockReturnValue(true)
 expect(await sleepGuard?.(()=>true)).toBe(true)
 expect(dispose).toHaveBeenCalledOnce()
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

test('editor Open accepts the ready active frame or a visible split frame in a live workspace',async()=>{
 let sessionActive=true
 const open=vi.fn(()=>true),selectPane=vi.fn()
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const render=(active:boolean,split=false)=>act(async()=>root.render(h(DocumentFrame,{
  file,registerGuard:()=>{},sessionActive:()=>sessionActive,documentShortcutsActive:active,onOpenWorkspaceFile:open,
  onPaneInteraction:split?selectPane:undefined,
 })))
 await render(true)
 const frame=host.querySelector('iframe')! as WorkspaceOpenFrame
 const requestOpen=()=>frame.dyofficeOpenWorkspaceFile?.()
 expect(requestOpen()).toBe(false)
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{
  source:frame.contentWindow,origin:location.origin,data:{type:'dyoffice-document-loading',state:'ready'},
 })))
 expect(requestOpen()).toBe(true)
 await render(false)
 expect(requestOpen()).toBe(false)
 await render(false,true)
 expect(requestOpen()).toBe(true)
 expect(selectPane).toHaveBeenCalledOnce()
 open.mockReturnValueOnce(false)
 expect(requestOpen()).toBe(false)
 expect(selectPane).toHaveBeenCalledOnce()
 await render(true)
 sessionActive=false
 expect(requestOpen()).toBe(false)
 sessionActive=true
 expect(requestOpen()).toBe(true)
 await act(async()=>root.render(null))
 expect(requestOpen()).toBe(false)
 expect(open).toHaveBeenCalledTimes(4)
})

test('workspace print, Save and Save As shortcuts target only the active, ready document',async()=>{
 let sessionActive=true
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const second={...file,id:'b',name:'Test.xlsx',format:'xlsx' as const,src:'/native-xlsx/?fileId=b'}
 const render=(active:string)=>act(async()=>root.render([file,second].map(document=>h(DocumentFrame,{
  key:document.id,file:document,registerGuard:()=>{},sessionActive:()=>sessionActive,
  documentShortcutsActive:active===document.id,
 }))))
 await render('a')
 const [firstFrame,secondFrame]=[...host.querySelectorAll('iframe')]
 const firstPrint=vi.fn((event:Event)=>event.preventDefault())
 const secondPrint=vi.fn((event:Event)=>event.preventDefault())
 const secondCopy=vi.fn((event:Event)=>event.preventDefault())
 const firstSave=vi.fn((event:Event)=>event.preventDefault())
 const secondSave=vi.fn((event:Event)=>event.preventDefault())
 firstFrame.contentWindow!.addEventListener('dyoffice-print-document',firstPrint)
 secondFrame.contentWindow!.addEventListener('dyoffice-print-document',secondPrint)
 secondFrame.contentWindow!.addEventListener('dyoffice-save-document-copy',secondCopy)
 firstFrame.contentWindow!.addEventListener('dyoffice-save-document',firstSave)
 secondFrame.contentWindow!.addEventListener('dyoffice-save-document',secondSave)
 const ready=(frame:HTMLIFrameElement)=>act(async()=>window.dispatchEvent(new MessageEvent('message',{
  source:frame.contentWindow,origin:location.origin,data:{type:'dyoffice-document-loading',state:'ready'},
 })))
 const shortcut=(init:KeyboardEventInit={})=>{
  const key=new KeyboardEvent('keydown',{key:'p',ctrlKey:true,cancelable:true,...init})
  window.dispatchEvent(key)
  return key.defaultPrevented
 }
 expect(shortcut()).toBe(false)
 expect(shortcut({key:'s'})).toBe(false)
 await ready(firstFrame);await ready(secondFrame)
 expect(shortcut()).toBe(true)
 expect(firstPrint).toHaveBeenCalledOnce()
 expect(secondPrint).not.toHaveBeenCalled()
 expect(shortcut({shiftKey:true})).toBe(false)
 await render('b')
 expect(shortcut({ctrlKey:false,metaKey:true})).toBe(true)
 expect(firstPrint).toHaveBeenCalledOnce()
 expect(secondPrint).toHaveBeenCalledOnce()
 expect(shortcut({key:'S',shiftKey:true})).toBe(true)
 expect(secondCopy).toHaveBeenCalledOnce()
 expect(shortcut({key:'S',shiftKey:true,repeat:true})).toBe(true)
 expect(secondCopy).toHaveBeenCalledOnce()
 expect(shortcut({key:'s'})).toBe(true)
 expect(shortcut({key:'s',repeat:true})).toBe(true)
 expect(firstSave).not.toHaveBeenCalled()
 expect(secondSave).toHaveBeenCalledOnce()
 sessionActive=false
 expect(shortcut()).toBe(false)
 expect(shortcut({key:'s'})).toBe(false)
 expect(shortcut({key:'S',shiftKey:true})).toBe(false)
 expect(secondPrint).toHaveBeenCalledOnce()
 expect(secondCopy).toHaveBeenCalledOnce()
 expect(secondSave).toHaveBeenCalledOnce()
})

test('a tab menu command waits for the chosen editor and is only consumed once',async()=>{
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const claim=vi.fn(()=>true),result=vi.fn()
 const command={id:file.id,command:'print' as const,claim,complete:result}
 const render=(active:boolean)=>act(async()=>root.render(h(DocumentFrame,{
  file,registerGuard:()=>{},sessionActive:()=>true,documentShortcutsActive:active,
  menuCommand:command,
 })))
 await render(false)
 const frame=host.querySelector('iframe')!
 const print=vi.fn((event:Event)=>event.preventDefault())
 frame.contentWindow!.addEventListener('dyoffice-print-document',print)
 await render(true)
 expect(print).not.toHaveBeenCalled()
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{
  source:frame.contentWindow,origin:location.origin,data:{type:'dyoffice-document-loading',state:'ready'},
 })))
 expect(print).toHaveBeenCalledOnce()
 expect(result).toHaveBeenCalledWith(true)
 await render(false);await render(true)
 expect(print).toHaveBeenCalledOnce()
})

test('document zoom shortcuts target the active tab or the focused split editor',async()=>{
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const slides={...file,id:'b',name:'Test.pptx',format:'pptx' as const,src:'/native-pptx/?fileId=b'}
 const selectSlides=vi.fn()
 const render=(split:boolean)=>act(async()=>root.render([file,slides].map(document=>h(DocumentFrame,{
  key:document.id,file:document,registerGuard:()=>{},sessionActive:()=>true,
  documentShortcutsActive:document===file,onPaneInteraction:document===slides&&split?selectSlides:undefined,
 }))))
 await render(false)
 const [wordFrame,slideFrame]=[...host.querySelectorAll('iframe')]
 const wordZoom=vi.fn((event:Event)=>event.preventDefault())
 const slideZoom=vi.fn((event:Event)=>event.preventDefault())
 wordFrame.contentWindow!.addEventListener('dyoffice-zoom-in',wordZoom)
 slideFrame.contentWindow!.addEventListener('dyoffice-zoom-reset',slideZoom)
 const shortcut=(target:Window,init:KeyboardEventInit)=>{
  const key=new KeyboardEvent('keydown',{ctrlKey:true,cancelable:true,...init})
  target.dispatchEvent(key)
  return key.defaultPrevented
 }
 expect(shortcut(window,{key:'='})).toBe(false)
 for(const frame of [wordFrame,slideFrame]){
  await act(async()=>window.dispatchEvent(new MessageEvent('message',{
   source:frame.contentWindow,origin:location.origin,data:{type:'dyoffice-document-loading',state:'ready'},
  })))
 }
 expect(shortcut(window,{key:'='})).toBe(true)
 expect(shortcut(wordFrame.contentWindow!,{key:'+',shiftKey:true,repeat:true})).toBe(true)
 expect(wordZoom).toHaveBeenCalledTimes(2)
 expect(shortcut(slideFrame.contentWindow!,{key:'0'})).toBe(false)
 await render(true)
 expect(shortcut(slideFrame.contentWindow!,{key:'0',ctrlKey:false,metaKey:true})).toBe(true)
 expect(slideZoom).toHaveBeenCalledOnce()
 expect(selectSlides).toHaveBeenCalledOnce()
 expect(shortcut(window,{key:'=',altKey:true})).toBe(false)
})

test('editor drops queue workspace documents and let editor-owned drops keep their behavior',async()=>{
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 const openFiles=vi.fn(()=>true)
 await act(async()=>root.render(h(DocumentFrame,{
  file,registerGuard:()=>{},sessionActive:()=>true,documentShortcutsActive:true,onDropWorkspaceFiles:openFiles,
 })))
 const frame=host.querySelector('iframe')!
 const editor=frame.contentWindow!
 editor.addEventListener('drop',event=>event.preventDefault(),{once:true})
 await act(async()=>window.dispatchEvent(new MessageEvent('message',{
  source:frame.contentWindow,origin:location.origin,data:{type:'dyoffice-document-loading',state:'ready'},
 })))
 const drop=(...files:File[])=>{
  const event=new Event('drop',{bubbles:true,cancelable:true})
  Object.defineProperty(event,'dataTransfer',{value:{files}})
  return editor.dispatchEvent(event)
 }
 const office=new File(['test'],'slides.PPTX')
 expect(drop(office)).toBe(false)
 expect(openFiles).not.toHaveBeenCalled()
 expect(drop(new File(['image'],'photo.png'))).toBe(false)
 expect(openFiles).not.toHaveBeenCalled()
 expect(drop(office)).toBe(false)
 expect(openFiles).toHaveBeenCalledExactlyOnceWith([office])
})
