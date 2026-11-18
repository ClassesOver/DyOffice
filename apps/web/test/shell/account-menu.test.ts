import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {ConfigProvider} from 'antd'
import {AccountMenu} from '../../src/shell/AccountMenu'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const cleanups:Array<()=>Promise<void>>=[]
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:100,height:30,left:20,top:500,right:120,bottom:530,x:20,y:500,toJSON(){}});vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});vi.stubGlobal('matchMedia',vi.fn((query:string)=>({matches:false,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()})));})
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()})
async function mount(roles:string[]=[]){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 const actions={onSettings:vi.fn(),onTrash:vi.fn(),onSources:vi.fn(),onGlobalSettings:vi.fn(),onUsers:vi.fn(),onLogout:vi.fn()}
 await act(async()=>root.render(h(ConfigProvider,{theme:{token:{motion:false}},children:h(AccountMenu,{user:{username:'alice',displayName:'爱丽丝',roles},...actions})})))
 cleanups.push(async()=>{await act(async()=>root.unmount());host.remove()})
 return {host,actions,trigger:host.querySelector('button')!}
}
function items(){return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]}
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,100))})}
async function open(trigger:HTMLButtonElement){await act(async()=>trigger.click());await settle()}
test('opens a portal menu with personal actions and only shows administration for config admins',async()=>{
 const ordinary=await mount();expect(ordinary.trigger).not.toBeNull();await open(ordinary.trigger)
 expect(ordinary.trigger.getAttribute('aria-expanded')).toBe('true')
 expect(document.querySelector('.ant-dropdown-menu[role="menu"]')).not.toBeNull();expect(ordinary.host.querySelector('[role="menu"]')).toBeNull()
 expect(items().map(x=>x.textContent)).toEqual(['个人设置','回收站','数据连接','退出登录'])
 await open(ordinary.trigger)
 const admin=await mount(['config_admin']);await open(admin.trigger)
 expect(items().map(x=>x.textContent)).toEqual(['个人设置','回收站','数据连接','全局配置','用户管理','退出登录'])
})
test('keyboard navigation wraps, Escape closes and returns focus to the trigger',async()=>{
 const {trigger}=await mount();await open(trigger);expect(document.activeElement).toBe(items()[0])
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',keyCode:38,bubbles:true})))
 await settle();expect(document.activeElement).toBe(items().at(-1))
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 await settle();expect(items()).toHaveLength(0);expect(document.activeElement).toBe(trigger);expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
test('outside pointer and Tab dismiss; action invokes its callback once after closing',async()=>{
 const {trigger,actions}=await mount();await open(trigger)
 await act(async()=>document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})))
 await settle();expect(items()).toHaveLength(0)
 await open(trigger);await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true})))
 await settle();expect(items()).toHaveLength(0)
 await open(trigger);await act(async()=>items()[0]!.click())
 await settle();expect(items()).toHaveLength(0);expect(actions.onSettings).toHaveBeenCalledTimes(1)
})
