import {describe,it,expect,vi} from 'vitest'
import {createLocalShellClient} from '../../src/shell/local-client'
import {createLocalNewSheet,localNewFormats} from '../../src/shell/local-new-sheet'
function setup() {
 const request=vi.fn(async(path:string)=>{
  if(path==='/api/v1/capabilities')return {xlsx:'editable'}
  if(path==='/api/v1/files/uploads')return {uploadId:'upload'}
  if(path.endsWith('/finish'))return {file:{fileId:'created'}}
 })
 const deps={getSessionProof:()=> 'A'.repeat(43),bindSession:vi.fn(async()=>({request})),fetchTemplate:vi.fn(async()=>new Response('xlsx')),open:vi.fn(async()=>{}),changed:vi.fn()}
 return {deps,request,create:createLocalNewSheet(deps as any)}
}
describe('capability-gated XLSX creation',()=>{
 it('keeps PPTX/PDF disabled even when a caller supplies editable; fails closed without XLSX',()=>{
  expect(localNewFormats({docx:'editable',xlsx:'editable',pptx:'editable',pdf:'editable'})).toEqual(['docx','xlsx'])
  expect(localNewFormats({xlsx:'unsupported'})).toEqual([])
 })
 it('uploads the blank template through bound requests then opens exactly that file',async()=>{
  const {deps,request,create}=setup();await create()
  expect(deps.bindSession).toHaveBeenCalledWith('A'.repeat(43))
  expect(request.mock.calls.map(c=>c[0])).toEqual(['/api/v1/capabilities','/api/v1/capabilities','/api/v1/files/uploads','/api/v1/uploads/upload/content','/api/v1/uploads/upload/finish'])
  expect(request).toHaveBeenCalledWith('/api/v1/files/uploads','POST',{name:'未命名.xlsx',size:4})
  expect(deps.open).toHaveBeenCalledWith('created',request)
 })
 it('does not fetch or upload when the runtime is unsupported',async()=>{
  const {deps,request,create}=setup();request.mockResolvedValue({xlsx:'unsupported'} as any)
  await expect(create()).rejects.toThrow();expect(deps.fetchTemplate).not.toHaveBeenCalled()
 })
 it('rechecks capability after template download before any write',async()=>{
  const {request,create}=setup();request.mockResolvedValueOnce({xlsx:'editable'} as any).mockResolvedValueOnce({xlsx:'unsupported'} as any)
  await expect(create()).rejects.toThrow();expect(request).toHaveBeenCalledTimes(2)
 })
 it('does not upload a failed template response and allows retry',async()=>{
  const {deps,create}=setup();deps.fetchTemplate.mockResolvedValueOnce(new Response('',{status:404}))
  await expect(create()).rejects.toThrow();await create();expect(deps.open).toHaveBeenCalledTimes(1)
 })
 it('blocks concurrent creation while the template is loading',async()=>{
  const {deps,create}=setup();let done!:(r:Response)=>void
  deps.fetchTemplate.mockReturnValueOnce(new Promise(resolve=>{done=resolve}))
  const first=create();await vi.waitFor(()=>expect(deps.fetchTemplate).toHaveBeenCalled())
  await expect(create()).rejects.toThrow('正在');done(new Response('xlsx'));await first
  expect(deps.open).toHaveBeenCalledTimes(1)
 })
 it('reports committed upload with failed open without retrying the upload',async()=>{
  const {deps,request,create}=setup();deps.open.mockRejectedValue(new Error('frame failed'))
  await expect(create()).rejects.toThrow('已创建');expect(deps.changed).toHaveBeenCalled()
  expect(request.mock.calls.filter(c=>c[0].endsWith('/finish'))).toHaveLength(1)
 })
 it('locks after an unknown finish response rather than duplicating a possibly-created file',async()=>{
  const {request,create}=setup();request.mockImplementation(async(path)=>{if(path==='/api/v1/capabilities')return {xlsx:'editable'} as any;if(path==='/api/v1/files/uploads')return {uploadId:'upload'} as any;if(path.endsWith('/finish'))throw new Error('network')})
  await expect(create()).rejects.toThrow('无法确认');await expect(create()).rejects.toThrow('无法确认')
  expect(request.mock.calls.filter(c=>c[0].endsWith('/finish'))).toHaveLength(1)
 })
 it('does not write when the pinned session rejects the second capability read',async()=>{
  const {request,create}=setup();request.mockResolvedValueOnce({xlsx:'editable'} as any).mockRejectedValueOnce(new Error('stale_session'))
  await expect(create()).rejects.toThrow('stale_session');expect(request).toHaveBeenCalledTimes(2)
 })
 it('rejects an empty template before staging an upload',async()=>{
  const {deps,request,create}=setup();deps.fetchTemplate.mockResolvedValueOnce(new Response(''))
  await expect(create()).rejects.toThrow('模板无效');expect(request).toHaveBeenCalledTimes(1)
 })
 it('allows retry after a definite finish rejection, without retrying automatically',async()=>{
  const {request,create,deps}=setup();let attempts=0
  request.mockImplementation(async(path)=>{if(path==='/api/v1/capabilities')return {xlsx:'editable'} as any;if(path==='/api/v1/files/uploads')return {uploadId:'upload'} as any;if(path.endsWith('/finish')){if(!attempts++)throw Object.assign(new Error('invalid upload'),{status:400});return {file:{fileId:'created'}} as any}})
  await expect(create()).rejects.toThrow('invalid upload');expect(deps.open).not.toHaveBeenCalled()
  await create();expect(deps.open).toHaveBeenCalledTimes(1)
 })

 it('rejects a Cookie account change before clicking instead of adopting the new account',async()=>{
  const originalProof='A'.repeat(43),rotatedProof='B'.repeat(43)
  const send=vi.fn(async(path:RequestInfo|URL)=>new Response(JSON.stringify(String(path).endsWith('/session-proof')?{csrfToken:rotatedProof}:String(path).endsWith('/finish')?{file:{fileId:'wrong-account-file'}}:String(path)==='/api/v1/files/uploads'?{uploadId:'wrong-account-upload'}:{xlsx:'editable'}),{headers:{'Content-Type':'application/json'}}))
  const client=createLocalShellClient(send as typeof fetch)
  const template=vi.fn(async()=>new Response('xlsx'))
  const create=createLocalNewSheet({getSessionProof:()=>originalProof,bindSession:proof=>client.bindSession(proof),fetchTemplate:template,open:async()=>{},changed:()=>{}} as any)
  await expect(create()).rejects.toThrow('登录状态已改变')
  expect(template).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledTimes(1)
 })

 it('refuses to adopt any cookie when the workspace has no verified session proof',async()=>{
  const {deps}=setup();const create=createLocalNewSheet({...deps,getSessionProof:()=>undefined} as any)
  await expect(create()).rejects.toThrow('登录状态未核验')
  expect(deps.bindSession).not.toHaveBeenCalled()
  expect(deps.fetchTemplate).not.toHaveBeenCalled()
 })

})

import {openCreatedDocument} from '../../src/shell/local-new-sheet'
import {createDocumentTabs} from '../../src/shell/document-tabs'
it('uses the bound #159 reader and does not let a late created-file read steal newer selection',async()=>{
 const tabs=createDocumentTabs();let resolve!:(v:unknown)=>void
 const request=vi.fn((path:string)=>path==='/api/v1/files/new'?new Promise(r=>{resolve=r}):Promise.resolve(undefined))
 const opening=openCreatedDocument(tabs,{xlsx:'editable'},'new',request as any)
 tabs.open({id:'later',name:'Later.pdf',format:'pdf',src:'/later'})
 resolve({name:'Created.xlsx',format:'xlsx',file:{fileId:'new',revision:'r1'},downloadEndpoint:'/api/v1/files/new/content?revision=r1'})
 await opening
 expect(request.mock.calls.map(c=>c[0])).toEqual(['/api/v1/files/new','/api/v1/workspace/files/new/open'])
 expect(tabs.list().find(t=>t.active)?.id).toBe('later')
 expect(tabs.documents().find(t=>t.id==='new')?.src).toBe('/native-xlsx/?fileId=new')
})
it('rejects a mismatched file receipt before mark-open or adding a created tab',async()=>{
 const tabs=createDocumentTabs();const request=vi.fn(async()=>({name:'Wrong.xlsx',format:'xlsx',file:{fileId:'other',revision:'r1'},downloadEndpoint:'/api/v1/files/other/content?revision=r1'}))
 await expect(openCreatedDocument(tabs,{xlsx:'editable'},'new',request as any)).rejects.toThrow('文件格式或下载地址无效')
 expect(request).toHaveBeenCalledTimes(1);expect(tabs.documents()).toEqual([])
})
