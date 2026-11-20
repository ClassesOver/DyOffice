import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {AccountMenu} from '../../src/shell/AccountMenu'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const cleanups:Array<()=>Promise<void>>=[]
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:100,height:30,left:20,top:500,right:120,bottom:530,x:20,y:500,toJSON(){}});vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});vi.stubGlobal('matchMedia',vi.fn((query:string)=>({matches:false,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()})));})
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()})
async function mount(roles:string[]=[],collaboration=false){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 const actions={...(collaboration?{onChannels:vi.fn(),onTasks:vi.fn()}:{}),onSettings:vi.fn(),onTrash:vi.fn(),onSources:vi.fn(),onGlobalSettings:vi.fn(),onUsers:vi.fn(),onLogout:vi.fn()}
 await act(async()=>root.render(h(AccountMenu,{user:{username:'alice',displayName:'爱丽丝',roles},...actions})))
 cleanups.push(async()=>{await act(async()=>root.unmount());host.remove()})
 return {host,actions,trigger:host.querySelector('button')!}
}
function items(){return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]}
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,100))})}
async function open(trigger:HTMLButtonElement){await act(async()=>trigger.click());await settle()}
test('opens a portal menu with personal actions and only shows administration for config admins',async()=>{
 const ordinary=await mount();expect(ordinary.trigger).not.toBeNull();await open(ordinary.trigger)
 expect(ordinary.trigger.querySelector('.account-name')?.textContent).toBe('个人工作区')
 expect(ordinary.trigger.querySelector('.account-sub')?.textContent).toBe('爱丽丝')
 expect(ordinary.trigger.querySelector('.account-menu-toggle')).not.toBeNull()
 expect(document.querySelector('.account-menu-heading')?.textContent).toBe('个人工作区成员')
 expect(ordinary.trigger.getAttribute('aria-expanded')).toBe('true')
 expect(document.querySelector('[role="menu"]')).not.toBeNull();expect(ordinary.host.querySelector('[role="menu"]')).toBeNull()
 expect(items().map(x=>x.textContent)).toEqual(['个人设置','回收站','退出登录'])
 expect([...document.querySelectorAll('.account-menu-group-title')].map(node=>node.textContent)).toEqual(['个人工作区'])
 await open(ordinary.trigger)
 const admin=await mount(['config_admin']);await open(admin.trigger)
 expect(items().map(x=>x.textContent)).toEqual(['个人设置','回收站','数据连接','全局配置','用户管理','退出登录'])
 expect([...document.querySelectorAll('.account-menu-group-title')].map(node=>node.textContent)).toEqual(['个人工作区','组织管理'])
})
test('keyboard navigation wraps, Escape closes and returns focus to the trigger',async()=>{
 const {trigger}=await mount();await open(trigger);expect(document.activeElement).toBe(items()[0])
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',keyCode:38,bubbles:true})))
 await settle();expect(document.activeElement).toBe(items().at(-1))
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 await settle();expect(items()).toHaveLength(0);expect(document.activeElement).toBe(trigger);expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
test('trigger arrows choose the first or last item; Home and End navigate the native menu',async()=>{
 const {trigger}=await mount(['config_admin'])
 trigger.focus()
 await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true})))
 expect(document.activeElement).toBe(items().at(-1))
 for(const [key,index] of [['Home',0],['End',items().length-1],['ArrowDown',0]] as const){
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})))
  expect(document.activeElement).toBe(items()[index])
 }
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 expect(document.activeElement).toBe(trigger)
 await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
 expect(document.activeElement).toBe(items()[0])
})
test('avatar, name, workspace caption and arrow all activate the same account menu',async()=>{
 const {trigger}=await mount()
 for(const selector of ['.account-menu-avatar','.account-name','.account-sub','.account-menu-chevron']){
  const target=trigger.querySelector<HTMLElement>(selector)!
  expect(target).not.toBeNull()
  await act(async()=>target.dispatchEvent(new MouseEvent('click',{bubbles:true})))
  await settle();expect(trigger.getAttribute('aria-expanded')).toBe('true');expect(items()).toHaveLength(3)
  await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  await settle();expect(items()).toHaveLength(0);expect(document.activeElement).toBe(trigger)
 }
})
test('outside pointer and Tab dismiss; action invokes its callback once after closing',async()=>{
 const {trigger,actions}=await mount();await open(trigger)
 await act(async()=>document.body.dispatchEvent(new Event('pointerdown',{bubbles:true})))
 await settle();expect(items()).toHaveLength(0)
 await open(trigger);await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true})))
 await settle();expect(items()).toHaveLength(0)
 await open(trigger);await act(async()=>items()[0]!.click())
 await settle();expect(items()).toHaveLength(0);expect(actions.onSettings).toHaveBeenCalledTimes(1)
})

test('channel sharing and background tasks are peers of personal settings for ordinary users',async()=>{
 const {trigger,actions}=await mount([],true);await open(trigger)
 expect(items().map(x=>x.textContent)).toEqual(['个人设置','频道分享','后台任务','回收站','退出登录'])
 await act(async()=>items().find(x=>x.textContent==='频道分享')!.click());await settle()
 expect(actions.onChannels).toHaveBeenCalledOnce()
 await open(trigger);await act(async()=>items().find(x=>x.textContent==='后台任务')!.click());await settle()
 expect(actions.onTasks).toHaveBeenCalledOnce()
 expect(actions.onSettings).not.toHaveBeenCalled()
})

test('top account entry opens below and realigns above when the trigger moves',async()=>{
 const {trigger}=await mount(['config_admin'],true)
 const rect=vi.spyOn(trigger,'getBoundingClientRect').mockReturnValue({width:154,height:48,left:224,top:52,right:378,bottom:100,x:224,y:52,toJSON(){}})
 await open(trigger)
 const popup=document.querySelector<HTMLElement>('.account-menu-popover')!
 expect(popup.style.top).toBe('108px')
 expect(popup.style.maxHeight).toBe(`${window.innerHeight-120}px`)
 Object.defineProperty(popup,'scrollHeight',{configurable:true,value:500})
 rect.mockReturnValue({width:154,height:48,left:20,top:700,right:174,bottom:748,x:20,y:700,toJSON(){}})
 await act(async()=>window.dispatchEvent(new Event('resize')))
 expect(popup.style.top).toBe('190px')
 expect(popup.style.maxHeight).toBe('680px')
})
