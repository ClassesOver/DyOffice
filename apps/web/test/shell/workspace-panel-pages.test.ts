import {afterEach, expect, test, vi} from 'vitest'
import {act, createElement as h} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {SourcesPanel} from '../../src/shell/SourcesPanel'
import {WorkspaceDataResults} from '../../src/shell/WorkspaceDataResults'
import {WorkspaceTrash} from '../../src/shell/WorkspaceTrash'
import {createSourcesClient} from '../../src/shell/sources-client'
import {createSourceResultsClient} from '../../src/shell/source-results-client'

;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const roots:Root[]=[]
afterEach(async()=>{await act(async()=>{for(const root of roots.splice(0))root.unmount()});document.body.innerHTML='';vi.restoreAllMocks()})
async function mount(component:any,props:any){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root);await act(async()=>root.render(h(component,props)));return host}
const sourceClient=()=>createSourcesClient(async()=>({items:[],nextCursor:null}) as never)
const resultClient=()=>createSourceResultsClient(async()=>({items:[],nextCursor:null}) as never)
const button=(label:string)=>[...document.querySelectorAll('button')].find(node=>node.textContent===label)!

test.each([
 ['sources',SourcesPanel,()=>({client:sourceClient()})],
 ['results',WorkspaceDataResults,()=>({client:resultClient()})],
 ['trash',WorkspaceTrash,()=>({request:async()=>({files:[],total:0}),onChanged(){}})],
])('%s embedded page uses the host header and has no modal semantics',async(_name,component,props)=>{
 const close=vi.fn();const host=await mount(component,{...props(),presentation:'page',onClose:close})
 expect(host.querySelector('[role="dialog"], [aria-modal], .set-overlay')).toBeNull()
 expect(host.querySelector('.workspace-panel-header')).toBeNull()
 expect(host.querySelector(_name==='sources'?'.database-connections-list':'.workspace-panel-body')).not.toBeNull()
 if(_name==='results')expect(button('关闭')).toBeUndefined()
})

test('standalone results dialog closes through its callback',async()=>{
 const close=vi.fn();const host=await mount(WorkspaceDataResults,{client:resultClient(),onClose:close})
 expect(host.querySelector('[role=dialog] h2')?.textContent).toBeTruthy()
 await act(async()=>button('关闭').click());expect(close).toHaveBeenCalledOnce()
})

test('source page close guard confirms dirty drafts before closing',async()=>{
 const client=sourceClient();let guard:(()=>boolean)|null=null;const close=vi.fn()
 await mount(SourcesPanel,{client,presentation:'page',onClose:close,onCloseGuardChange:(value:(()=>boolean)|null)=>{guard=value}})
 await act(async()=>button('新建数据连接').click())
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 await act(async()=>{const field=document.querySelector<HTMLInputElement>('[aria-label="连接名称"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'未保存');field.dispatchEvent(new Event('input',{bubbles:true}))})
 expect(guard).toBeTypeOf('function');expect(guard!()).toBe(false)
 expect(document.querySelector('.workspace-panel-header')).toBeNull();expect(close).not.toHaveBeenCalled()
 confirm.mockReturnValue(true);expect(guard!()).toBe(true)
 expect(document.querySelector('.workspace-panel-header')).toBeNull()
})

test('trash page blocks pending and unknown restoration but releases guard after reload',async()=>{
 const file={id:'a',name:'a.docx',format:'docx',size:12};let reject!:(e:Error)=>void;let guard:(()=>boolean)|null=null
 await mount(WorkspaceTrash,{presentation:'page',request:async(_path:string,method?:string)=>method==='POST'?new Promise((_resolve,fail)=>{reject=fail}):{files:[file],total:1},onClose(){},onChanged(){},onCloseGuardChange:(value:(()=>boolean)|null)=>{guard=value}})
 expect(guard).toBeNull()
 await act(async()=>button('恢复').click());expect(guard).toBeTypeOf('function')
 await act(async()=>{expect(guard!()).toBe(false)})
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('处理中')
 await act(async()=>reject(Error('lost response')))
 await act(async()=>{expect(guard!()).toBe(false)})
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('核对')
 await act(async()=>button('重新加载').click());expect(guard).toBeNull()
})

test('source page refuses closing during a write and after its outcome becomes unknown',async()=>{
 let reject!:(error:Error)=>void;let guard:(()=>boolean)|null=null
 const client=createSourcesClient(async(_path,method)=>method==='POST'?new Promise((_resolve,fail)=>{reject=fail}):({items:[],nextCursor:null}) as never)
 await mount(SourcesPanel,{client,presentation:'page',onClose(){},onCloseGuardChange:(value:(()=>boolean)|null)=>{guard=value}})
 await act(async()=>button('新建数据连接').click())
 await act(async()=>{for(const [label,value] of [['连接标识','sales'],['连接名称','收入'],['连接凭据','postgresql://qa:qa@db.example/qa']]){const field=document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}))}})
 await act(async()=>button('保存连接').click())
 await act(async()=>{expect(guard!()).toBe(false)})
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('处理中')
 await act(async()=>reject(Error('lost response')))
 await act(async()=>{expect(guard!()).toBe(false)})
 expect(document.body.textContent).toContain('核对')
 expect(button('放弃修改').disabled).toBe(true)
 await act(async()=>button('返回连接列表').click())
 expect(document.querySelector('[aria-label="连接名称"]')).not.toBeNull()
 await act(async()=>button('放弃修改').click())
 expect(document.querySelector<HTMLInputElement>('[aria-label="连接标识"]')?.value).toBe('sales')
 expect(button('读取最新配置并核对')).toBeDefined()
 await act(async()=>{expect(guard!()).toBe(false)})
})
