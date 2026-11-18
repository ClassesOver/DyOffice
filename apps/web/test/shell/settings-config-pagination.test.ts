import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {SourcesPanel} from '../../src/shell/SourcesPanel'
import {createSourcesClient} from '../../src/shell/sources-client'
import {GlobalSettingsPanel} from '../../src/shell/GlobalSettingsPanel'
import {createGlobalSettingsClient} from '../../src/shell/global-settings-client'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root|undefined
const source=(id:string)=>({sourceId:id,name:id,kind:'postgres',version:1,enabled:true,publishedRevision:null,hasCredential:true,hasUnpublishedChanges:false,updatedAt:'2026-11-17T00:00:00Z'})
async function mount(node:ReturnType<typeof h>){document.body.innerHTML='<div id="config-pages"></div>';root=createRoot(document.getElementById('config-pages')!);await act(async()=>root!.render(node))}
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML='';vi.restoreAllMocks()})
const button=(label:string)=>{const found=document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)??[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);expect(found,label).toBeDefined();return found!}
async function click(label:string){await act(async()=>button(label).click())}
async function fill(label:string,value:string){await act(async()=>{const input=document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))})}
test('source cursor pages replace list rows, retain failed-page identity, and navigate back without losing the selected editor',async()=>{
 let fail=true
 const reads:string[]=[]
 const client=createSourcesClient((async(path:string)=>{reads.push(path);if(!path.includes('?'))return {source:source('first-source'),config:{timezone:'UTC',maxRows:10,units:{}},published:null};if(path.includes('after=')&&fail)throw Error('page failed');return path.includes('after=')?{items:[source('second-source')],nextCursor:null}:{items:[source('first-source')],nextCursor:'first-source'}}) as Parameters<typeof createSourcesClient>[0])
 await mount(h(SourcesPanel,{client,onClose(){}}))
 await act(async()=>document.querySelector<HTMLButtonElement>('.source-item')!.click())
 await click('下一页数据连接');expect(document.querySelector('.source-list')?.textContent).toContain('first-source')
 expect(document.querySelector('.source-list')?.textContent).toContain('第 1 页')
 fail=false;await click('下一页数据连接')
 expect(document.querySelector('.source-list')?.textContent).not.toContain('first-source')
 expect(document.querySelector('.source-list')?.textContent).toContain('second-source')
 expect(document.querySelector('.source-workbench-heading')?.textContent).toContain('first-source')
 await click('上一页数据连接');expect(document.querySelector('.source-list')?.textContent).toContain('first-source')
 expect(reads.filter(path=>path.includes('after='))).toHaveLength(2)
})
test('source paging locks while the selected connection has an unsaved draft',async()=>{
 const client=createSourcesClient((async(path:string)=>path.includes('?')?{items:[source('first-source')],nextCursor:'first-source'}:{source:source('first-source'),config:{timezone:'UTC',maxRows:10,units:{}},published:null}) as Parameters<typeof createSourcesClient>[0])
 await mount(h(SourcesPanel,{client,onClose(){}}));await act(async()=>document.querySelector<HTMLButtonElement>('.source-item')!.click())
 await fill('连接名称','Unsaved source')
 expect(button('下一页数据连接').disabled).toBe(true)
})
const config=()=>({revision:3,entries:Array.from({length:11},(_,n)=>({id:`entry-${n}`,kind:'chat',providerId:'openai',label:`Service ${n}`,model:'model-a',baseUrl:'https://example.test/v1',enabled:true,hasKey:true})),defaults:{chat:'entry-0'},keyStorageAvailable:true,providerCatalog:[{id:'openai',label:'OpenAI',kinds:['chat'],models:['model-a'],defaultBaseUrl:'https://example.test/v1',available:true}]})
test('global local pages bound the list without discarding cross-page names or secret drafts from the single save transaction',async()=>{
 let savedBody:any
 const client=createGlobalSettingsClient((async(_path:string,method?:string,body?:unknown)=>{if(method==='PUT'||method==='PATCH'){savedBody=body;return {...config(),revision:4}}return config()}) as Parameters<typeof createGlobalSettingsClient>[0])
 await mount(h(GlobalSettingsPanel,{client,onClose(){}}))
 expect(document.querySelectorAll('.global-settings-entry')).toHaveLength(10)
 await fill('配置名称','Edited first');await fill('API 密钥','first-secret')
 await click('下一页服务配置');expect(document.querySelectorAll('.global-settings-entry')).toHaveLength(1)
 expect((document.querySelector('[aria-label="配置名称"]') as HTMLInputElement).value).toBe('Service 10')
 await fill('配置名称','Edited last');await fill('API 密钥','last-secret')
 await click('上一页服务配置')
 expect((document.querySelector('[aria-label="配置名称"]') as HTMLInputElement).value).toBe('Edited first')
 expect((document.querySelector('[aria-label="API 密钥"]') as HTMLInputElement).value).toBe('first-secret')
 await act(async()=>document.querySelector('form[aria-label="全局配置表单"]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 expect(savedBody?.patch?.upserts??savedBody?.upserts).toEqual(expect.arrayContaining([expect.objectContaining({id:'entry-0',label:'Edited first',apiKey:'first-secret'}),expect.objectContaining({id:'entry-10',label:'Edited last',apiKey:'last-secret'})]))
})
test('result pages expose returned rows beyond the old 100-row slice without requerying or hiding truncation',async()=>{
 let queries=0
 const client=createSourcesClient((async(path:string)=>{if(path.endsWith('/query')){queries++;return {version:1,sourceId:'first-source',sourceVersion:1,timezone:'UTC',schema:[{name:'value',type:'string'}],rows:Array.from({length:101},(_,n)=>({value:`row-${n}`})),truncated:true,sha256:'b'.repeat(64)}}return path.includes('?')?{items:[source('first-source')],nextCursor:null}:{source:source('first-source'),config:{timezone:'UTC',maxRows:1000,units:{}},published:{sourceId:'first-source',revision:1,contentHash:'a'.repeat(64),publishedAt:'2026-11-17T00:00:00Z',name:'first-source',kind:'postgres',config:{},execution:{maxRows:1000}}}}) as Parameters<typeof createSourcesClient>[0])
 await mount(h(SourcesPanel,{client,onClose(){}}));await act(async()=>document.querySelector<HTMLButtonElement>('.source-item')!.click());await click('执行已发布查询')
 expect(document.querySelectorAll('.source-results tbody tr[data-row-key]')).toHaveLength(20)
 for(let n=0;n<5;n++)await click('下一页查询结果')
 expect(document.querySelector('.source-results')?.textContent).toContain('row-100')
 expect(document.querySelectorAll('.source-results tbody tr[data-row-key]')).toHaveLength(1)
 expect(document.querySelector('[aria-label="查询结果"]')?.textContent).toContain('结果已截断')
 expect(queries).toBe(1)
})
