import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {WorkspaceTrash} from '../../src/shell/WorkspaceTrash'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root
const row={id:'file-a',name:'report.docx',format:'docx',size:1024,updatedAt:'2026-01-01',starred:false,folderId:null,lastOpenedAt:null}
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML=''})
async function mount(request:any){document.body.innerHTML='<div id="trash"></div>';root=createRoot(document.getElementById('trash')!);await act(async()=>root.render(h(WorkspaceTrash,{request,presentation:'page',onClose(){},onChanged(){}})))}
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!
test('trash page renders one server page, honest metadata and local search without duplicate modal header',async()=>{
 const paths:string[]=[];await mount(async(path:string)=>{paths.push(path);return {files:[row],total:21}})
 expect(paths).toEqual(['/api/v1/workspace/files?view=trash&limit=10&offset=0'])
 expect(document.querySelector('.workspace-panel-header')).toBeNull()
 expect(document.body.textContent).toContain('最后修改')
 expect(document.body.textContent).not.toContain('删除时间')
 await act(async()=>{const input=document.querySelector<HTMLInputElement>('[aria-label="搜索当前页文件"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'missing');input.dispatchEvent(new Event('input',{bubbles:true}))})
 expect(document.body.textContent).toContain('当前页没有匹配文件')
 expect(paths).toHaveLength(1)
 await act(async()=>document.querySelector<HTMLElement>('.ant-pagination-item-2 a')!.click())
 expect(paths.at(-1)).toBe('/api/v1/workspace/files?view=trash&limit=10&offset=10')
})
test('permanent deletion is confirmed once, uses real purge API and reports deferred reclamation honestly',async()=>{
 let writes=0;const request=vi.fn(async(path:string,method?:string)=>{if(method==='POST'){writes++;expect(path).toBe('/api/v1/files/file-a/purge');return {state:'pending'}}return {files:[row],total:1}})
 await mount(request);await act(async()=>button('永久删除').click());expect(writes).toBe(0)
 expect(document.body.textContent).toContain('无法恢复')
 await act(async()=>button('确认永久删除').click())
 expect(writes).toBe(1);expect(document.body.textContent).toContain('后台回收')
 expect(document.querySelector('[data-row-key="file-a"]')).toBeNull()
})
test('unknown purge preserves the row and blocks repeat writes and close until reloading',async()=>{
 let guard:(()=>boolean)|null=null,writes=0
 document.body.innerHTML='<div id="trash"></div>';root=createRoot(document.getElementById('trash')!)
 const request=async(_path:string,method?:string)=>{if(method==='POST'){writes++;throw Error('lost response')}return {files:[row],total:1}}
 await act(async()=>root.render(h(WorkspaceTrash,{request:request as never,presentation:'page',onClose(){},onChanged(){},onCloseGuardChange:value=>{guard=value}})))
 await act(async()=>button('永久删除').click());await act(async()=>button('确认永久删除').click())
 expect(writes).toBe(1);expect(button('永久删除').disabled).toBe(true)
 await act(async()=>{expect(guard!()).toBe(false)})
 expect(document.body.textContent).toContain('核对')
 await act(async()=>button('重新加载').click());expect(guard).toBeNull()
 expect(button('永久删除').disabled).toBe(false);expect(writes).toBe(1)
})

for(const action of ['restore','purge'] as const)test(`successful ${action} of the only file on page two returns to an existing page`,async()=>{
 const rows=Array.from({length:11},(_,index)=>({...row,id:`file-${index}`,name:`report-${index}.docx`}))
 let current=rows;const offsets:number[]=[],writes:string[]=[]
 await mount(async(path:string,method?:string)=>{if(method==='POST'){writes.push(path);current=current.filter(file=>file.id!=='file-10');return action==='purge'?{state:'purged'}:undefined}const offset=Number(new URL(path,'http://local').searchParams.get('offset'));offsets.push(offset);return {files:current.slice(offset,offset+10),total:current.length}})
 await act(async()=>document.querySelector<HTMLElement>('.ant-pagination-item-2 a')!.click())
 expect(document.querySelector('[data-row-key="file-10"]')).not.toBeNull()
 if(action==='purge')await act(async()=>button('永久删除').click())
 await act(async()=>button(action==='restore'?'恢复':'确认永久删除').click())
 expect(writes).toEqual([`/api/v1/files/file-10/${action}`])
 expect(offsets).toEqual([0,10,0])
 expect(document.querySelectorAll('.ant-table-body [data-row-key]').length).toBe(10)
 expect(document.querySelector('.ant-pagination-item-active')?.textContent).toBe('1')
 expect(document.body.textContent).not.toContain('回收站为空。')
 await act(async()=>button('重新加载').click());expect(offsets.at(-1)).toBe(0)
})
test('an empty server page with a positive total loads a valid page instead of showing an empty recycle bin',async()=>{
 const offsets:number[]=[]
 await mount(async(path:string)=>{const offset=Number(new URL(path,'http://local').searchParams.get('offset'));offsets.push(offset);return offset===0?{files:[row],total:11}:{files:[],total:10}})
 await act(async()=>document.querySelector<HTMLElement>('.ant-pagination-item-2 a')!.click())
 expect(offsets).toEqual([0,10,0])
 expect(document.querySelector('[data-row-key="file-a"]')).not.toBeNull()
 expect(document.querySelector('.ant-pagination-item-active')?.textContent).toBe('1')
 expect(document.body.textContent).not.toContain('回收站为空。')
})

test('a confirmed restore followed by a page read failure stays confirmed and can be explicitly refreshed',async()=>{
 let written=false,readFails=true,writes=0
 await mount(async(path:string,method?:string)=>{if(method==='POST'){written=true;writes++;return undefined}if(written&&readFails)throw Error('read failed');const offset=Number(new URL(path,'http://local').searchParams.get('offset'));return {files:offset?[{...row,id:'last-file'}]:[row],total:written?10:11}})
 await act(async()=>document.querySelector<HTMLElement>('.ant-pagination-item-2 a')!.click())
 await act(async()=>button('恢复').click())
 expect(document.body.textContent).toContain('已恢复')
 expect(document.body.textContent).toContain('操作已成功，但列表刷新失败')
 expect(document.body.textContent).not.toContain('无法确认恢复结果')
 readFails=false;await act(async()=>button('重新加载').click())
 expect(document.querySelector('[data-row-key="file-a"]')).not.toBeNull();expect(button('恢复').disabled).toBe(false);expect(writes).toBe(1)
})
test('a contradictory empty first page with a positive total reports a read error without looping',async()=>{
 const request=vi.fn(async()=>({files:[],total:1}));await mount(request)
 expect(request).toHaveBeenCalledOnce()
 expect(document.body.textContent).toContain('回收站列表已变化，请重新加载核对。')
 expect(document.body.textContent).not.toContain('回收站为空。')
})
