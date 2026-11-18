import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {Home} from '../../../shell/src/renderer/src/Home'
import {LocaleProvider} from '../../../shell/src/renderer/src/locale'
import type {HomeApi} from '../../../shell/src/shared/home-api'
let root:Root,host:HTMLDivElement
const path='/workspace/project'
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);HTMLElement.prototype.scrollIntoView=vi.fn();HTMLElement.prototype.scrollTo=vi.fn();localStorage.clear()
 window.aiOffice={folderRoots:async()=>[{path:'/workspace',name:'My files',usable:true,readable:true,removable:false}],listFolder:async(dir:string)=>({dir,folders:dir==='/workspace'?[{path,name:'Project',mtimeMs:1,hasSubfolders:false}]:[],files:[]}),onFolderChanged:()=>()=>{},onOpenSettings:()=>()=>{},recents:async()=>({entries:[],total:0,totalAll:0}),starred:async()=>({entries:[],total:0,totalAll:0}),starredGroups:async()=>[]} as unknown as HomeApi
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root.render(h(LocaleProvider,{initial:'en',children:h(Home,{accountEntry:h('div',null,'Account'),supportedNewFormats:[],supportedFormats:['docx']})})))
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()})
const row=()=>[...host.querySelectorAll<HTMLElement>('.tree-row')].find(node=>node.querySelector('.tree-name')?.textContent==='Project')!
const trigger=()=>row().querySelector<HTMLButtonElement>('.folder-more-btn')!
async function key(node:HTMLElement,value:string){const event=new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true});await act(async()=>node.dispatchEvent(event));return event}
async function open(){await act(async()=>trigger().click());return document.body.querySelector<HTMLElement>('.folder-menu')!}
test('Enter on a folder action survives the parent tree keydown and starts rename',async()=>{
 const menu=await open(),rename=[...menu.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(node=>node.textContent==='Rename')!
 rename.focus();const event=await key(rename,'Enter')
 expect(rename.isConnected).toBe(true)
 expect(event.defaultPrevented).toBe(false)
 await act(async()=>rename.click())
 expect(host.querySelector<HTMLInputElement>('.folder-rename-input')?.value).toBe('Project')
})
test('folder menu arrows navigate and Escape restores its trigger',async()=>{
 const menu=await open(),items=[...menu.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
 expect(document.activeElement).toBe(items[0]);await key(items[0],'ArrowDown');expect(document.activeElement).toBe(items[1]);await key(items[1],'ArrowUp');expect(document.activeElement).toBe(items[0])
 await key(items[0],'Escape');expect(document.body.querySelector('.folder-menu')).toBeNull();expect(document.activeElement).toBe(trigger())
})
test('Tab dismisses the folder menu without trapping browser focus traversal',async()=>{
 const menu=await open(),first=menu.querySelector<HTMLElement>('[role=menuitem]')!;first.focus();const event=await key(first,'Tab')
 expect(document.body.querySelector('.folder-menu')).toBeNull();expect(event.defaultPrevented).toBe(false);expect(document.activeElement).toBe(trigger())
})
test('Enter on the sidebar menu trigger does not select its directory',async()=>{
 trigger().focus();const event=await key(trigger(),'Enter');expect(row().getAttribute('aria-selected')).toBe('false');expect(event.defaultPrevented).toBe(false)
})
