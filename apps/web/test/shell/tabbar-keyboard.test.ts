import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {TabBar} from '../../../shell/src/renderer/src/TabBar'
import {LocaleProvider} from '../../../shell/src/renderer/src/locale'
import type {TabSummary} from '../../../shell/src/shared/tabs-api'
let root:Root,host:HTMLDivElement,items:TabSummary[],changed:(tabs:TabSummary[])=>void
const activate=vi.fn(),close=vi.fn()
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);HTMLElement.prototype.scrollIntoView=vi.fn()
 items=[{id:'home',kind:'home',title:'Home',closable:false,active:true},{id:'a',kind:'pdf',title:'A.pdf',closable:true,active:false},{id:'b',kind:'pdf',title:'B.pdf',closable:true,active:false,dormant:true}]
 activate.mockReset().mockImplementation(async(id:string)=>{items=items.map(item=>({...item,active:item.id===id}));changed(items)})
 close.mockReset().mockResolvedValue(undefined)
 window.aiOfficeTabs={list:async()=>items,onChanged:listener=>{changed=listener;return()=>{}},activate,close} as unknown as typeof window.aiOfficeTabs
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(TabBar,{hideAppMenu:true,hideSingleTabList:true})})))
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()})
const tab=(index:number)=>host.querySelectorAll<HTMLElement>('.tab-item')[index]
async function key(node:HTMLElement,value:string){await act(async()=>node.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})))}
test('tabs expose selected state and use a single Tab stop with arrow/Home/End activation',async()=>{
 expect(host.querySelector('.tab-strip')?.getAttribute('role')).toBe('tablist')
 expect(tab(0).getAttribute('role')).toBe('tab');expect(tab(0).getAttribute('aria-selected')).toBe('true')
 expect([tab(0).tabIndex,tab(1).tabIndex,tab(2).tabIndex]).toEqual([0,-1,-1])
 tab(0).focus();await key(tab(0),'ArrowRight');expect(activate).toHaveBeenLastCalledWith('a');expect(document.activeElement).toBe(tab(1));expect(tab(1).getAttribute('aria-selected')).toBe('true')
 await key(tab(1),'End');expect(activate).toHaveBeenLastCalledWith('b');expect(document.activeElement).toBe(tab(2))
 await key(tab(2),'ArrowRight');expect(activate).toHaveBeenLastCalledWith('home')
 await key(tab(0),'ArrowLeft');expect(activate).toHaveBeenLastCalledWith('b')
 await key(tab(2),'Home');expect(activate).toHaveBeenLastCalledWith('home');expect(document.activeElement).toBe(tab(0));expect(close).not.toHaveBeenCalled()
})
test.each(['Enter',' '])('%s activates a focused tab without interpreting events from its close button',async value=>{
 tab(1).focus();await key(tab(1),value);expect(activate).toHaveBeenCalledWith('a');expect(close).not.toHaveBeenCalled()
 activate.mockClear();const button=tab(2).querySelector<HTMLButtonElement>('.tab-close')!;button.focus();await key(button,value);expect(activate).not.toHaveBeenCalled()
 await act(async()=>button.click());expect(close).toHaveBeenCalledWith('b');expect(tab(0).querySelector('.tab-close')).toBeNull()
})

test('unhandled shortcuts and close-button arrows do not change or close tabs',async()=>{
 const node=tab(0)
 const shortcut=new KeyboardEvent('keydown',{key:'Home',ctrlKey:true,bubbles:true,cancelable:true})
 await act(async()=>node.dispatchEvent(shortcut))
 expect(shortcut.defaultPrevented).toBe(false);expect(activate).not.toHaveBeenCalled()
 await key(node,'Delete');expect(close).not.toHaveBeenCalled()
 const button=tab(1).querySelector<HTMLButtonElement>('.tab-close')!;button.focus();await key(button,'ArrowRight')
 expect(activate).not.toHaveBeenCalled();expect(document.activeElement).toBe(button)
})

test('Web tab rename keeps the title extension and submits the file identity exactly once',async()=>{
 const renameTabFile=vi.fn(async()=>{})
 await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(TabBar,{renameTabFile})})))
 await act(async()=>tab(1).dispatchEvent(new MouseEvent('mousedown',{button:0,detail:2,bubbles:true,cancelable:true})))
 const input=tab(1).querySelector<HTMLInputElement>('.tab-rename-input')!
 expect(input?.value).toBe('A.pdf')
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Meeting')
  input.dispatchEvent(new Event('input',{bubbles:true}))
 })
 await key(input,'Enter')
 expect(renameTabFile).toHaveBeenCalledExactlyOnceWith('a','Meeting.pdf')
 expect(activate).not.toHaveBeenCalled()
})

test('Delete closes the focused document through its guard and restores tab strip focus only after removal',async()=>{
 const closeWithKeyboard=vi.fn(async(id:string)=>{
  items=items.filter(item=>item.id!==id).map(item=>({...item,active:item.id==='b'}))
  changed(items)
  return true
 })
 await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(TabBar,{closeTabWithKeyboard:closeWithKeyboard})})))
 await key(tab(0),'Delete')
 expect(closeWithKeyboard).not.toHaveBeenCalled()
 closeWithKeyboard.mockResolvedValueOnce(false)
 tab(1).focus()
 await key(tab(1),'Delete')
 expect(document.activeElement).toBe(tab(1))
 expect(tab(1).getAttribute('aria-label')).toBe('A.pdf')
 await key(tab(1),'Delete')
 expect(closeWithKeyboard).toHaveBeenCalledTimes(2)
 expect(closeWithKeyboard).toHaveBeenLastCalledWith('a')
 expect(tab(1).getAttribute('aria-label')).toBe('B.pdf')
 expect(document.activeElement).toBe(tab(1))
})
