import {afterEach,expect,test} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {readFileSync} from 'node:fs'
import {GlobalSettingsPanel} from '../../src/shell/GlobalSettingsPanel'
import {createGlobalSettingsClient} from '../../src/shell/global-settings-client'
import {UserSkillsPanel} from '../../src/shell/UserSkillsPanel'
import {createUserSkillsClient} from '../../src/shell/user-skills-client'
const roots:Root[]=[]
afterEach(async()=>{await act(async()=>{roots.splice(0).forEach(root=>root.unmount())});document.body.replaceChildren()})
async function mount(node:ReturnType<typeof h>){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root);await act(async()=>root.render(node));return host}
async function popup(label:string){const input=document.querySelector(`[role="combobox"][aria-label="${label}"]`)!;expect(input).not.toBeNull();await act(async()=>input.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})));const open=[...document.querySelectorAll<HTMLElement>('.ant-select-dropdown')].find(node=>!node.classList.contains('ant-select-dropdown-hidden'))!;expect(open).toBeDefined();return open}
test('global configuration Select popup uses B scope outside panel and preserves filter selection',async()=>{
 let writes=0
 const client=createGlobalSettingsClient(async(_path,method)=>{if(method&&method!=='GET')writes++;return {revision:1,entries:[],defaults:{},providerCatalog:[],keyStorageAvailable:true} as never})
 const host=await mount(h(GlobalSettingsPanel,{client,onClose(){}}))
 const layer=await popup('配置类型筛选')
 expect(host.contains(layer)).toBe(false)
 expect(layer.classList.contains('settings-select-b')).toBe(true)
 const options=[...layer.querySelectorAll<HTMLElement>('.ant-select-item-option')]
 expect(options.length).toBeGreaterThan(1)
 await act(async()=>options[1].click())
 expect(document.querySelector('[aria-label="配置类型筛选"]')?.closest('.ant-select')?.textContent).toContain(options[1].textContent)
 expect(writes).toBe(0)
})
test('personal skill format popup keeps B styling and real filtering without writes',async()=>{
 let writes=0
 const host=await mount(h(UserSkillsPanel,{client:createUserSkillsClient(async(_path,method)=>{if(method&&method!=='GET')writes++;return [] as never})}))
 const layer=await popup('筛选技能格式')
 expect(host.contains(layer)).toBe(false);expect(layer.classList.contains('settings-select-b')).toBe(true)
 const option=[...layer.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(node=>node.textContent==='PDF')!
 expect(option).toBeDefined();await act(async()=>option.click())
 expect(document.querySelector('[aria-label="筛选技能格式"]')?.closest('.ant-select')?.textContent).toContain('PDF');expect(writes).toBe(0)
})
test('popup B is isolated and tokenized with narrow, long label, active and disabled treatment',()=>{
 const css=readFileSync('src/shell/settings-select-b.css','utf8')
 expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i)
 expect(css).not.toContain('.workspace-config-modal')
 for(const token of ['surface','text','text-secondary','accent','accent-soft','border-subtle','shadow-menu'])expect(css).toContain(`var(--${token})`)
 for(const rule of ['.settings-select-b.ant-select-dropdown','max-width:calc(100vw - 32px)','white-space:normal','overflow-wrap:anywhere','option-selected','option-active','option-disabled'])expect(css).toContain(rule)
})
test.each(['light','dark','system'] as const)('popup tokens are defined for the %s theme without local hard-coded colors',theme=>{
 const css=readFileSync('src/shell/settings-select-b.css','utf8')
 const sources=['../../packages/ui/src/tokens.css','../shell/src/renderer/src/home.css'].map(path=>readFileSync(path,'utf8'))
 const sections=sources.map(source=>theme==='light'?source.slice(0,source.indexOf("\n[data-theme='dark']")):theme==='dark'?source.slice(source.indexOf("\n[data-theme='dark']"),source.indexOf('@media (prefers-color-scheme: dark)')):source.slice(source.indexOf('@media (prefers-color-scheme: dark)'))).join('\n')
 for(const [,token] of css.matchAll(/var\((--[\w-]+)\)/g))expect(sections,`${theme} ${token}`).toContain(`${token}:`)
})
