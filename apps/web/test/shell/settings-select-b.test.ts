import {afterEach,expect,test} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {readFileSync} from 'node:fs'
import {GlobalSettingsPanel} from '../../src/shell/GlobalSettingsPanel'
import {createGlobalSettingsClient} from '../../src/shell/global-settings-client'
import {UserSkillsPanel} from '../../src/shell/UserSkillsPanel'
import {createUserSkillsClient} from '../../src/shell/user-skills-client'
import type {AdminGlobalConfig} from '../../../../packages/web-contracts/src/settings'
const roots:Root[]=[]
afterEach(async()=>{await act(async()=>{roots.splice(0).forEach(root=>root.unmount())});document.body.replaceChildren()})
async function mount(node:ReturnType<typeof h>){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root);await act(async()=>root.render(node));return host}
function select(host:HTMLElement,label:string){const control=host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);expect(control).not.toBeNull();return control!}
async function choose(control:HTMLSelectElement,value:string){await act(async()=>{control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}))})}
test('global configuration type filter limits selectable services without writing',async()=>{
 let writes=0
 const common={providerId:'example',model:'model',baseUrl:'https://example.test/v1',enabled:true,hasKey:true}
 const config:AdminGlobalConfig={revision:1,entries:[
  {...common,id:'images',kind:'image_generation',label:'Image service'},
  {...common,id:'search',kind:'web_search',label:'Search service'},
 ],defaults:{},providerCatalog:[],keyStorageAvailable:true}
 const client=createGlobalSettingsClient(async(_path,method)=>{if(method&&method!=='GET')writes++;return config as never})
 const host=await mount(h(GlobalSettingsPanel,{client,onClose(){}}))
 await act(async()=>{[...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(node=>node.textContent?.includes('生图、媒体与搜索'))!.click()})
 const filter=select(host,'配置类型筛选'),services=select(host,'选择服务配置')
 expect(services.textContent).toContain('Image service')
 expect(services.textContent).toContain('Search service')
 await choose(filter,'web_search')
 expect(filter.selectedOptions[0]?.textContent).toBe('网页搜索')
 expect(services.selectedOptions[0]?.textContent).toBe('Search service')
 expect(services.textContent).not.toContain('Image service')
 expect(writes).toBe(0)
})
test('personal skill format filter limits catalog rows without writing',async()=>{
 let writes=0
 const host=await mount(h(UserSkillsPanel,{client:createUserSkillsClient(async(_path,method)=>{if(method&&method!=='GET')writes++;return [] as never})}))
 const filter=select(host,'筛选技能格式')
 const formats=()=>[...host.querySelectorAll('.personal-skills-catalog tbody tr[data-row-key]')].map(row=>[...row.querySelectorAll('.skill-formats span')].map(format=>format.textContent))
 expect(formats().some(row=>!row.includes('PDF'))).toBe(true)
 await choose(filter,'pdf')
 expect(filter.selectedOptions[0]?.textContent).toBe('PDF')
 expect(formats().length).toBeGreaterThan(0)
 expect(formats().every(row=>row.includes('PDF'))).toBe(true)
 expect(writes).toBe(0)
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
