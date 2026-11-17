import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {WorkspaceTrash} from '../../src/shell/WorkspaceTrash'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
let root:Root
const file=(index:number)=>({id:`file-${index}`,name:`report-${index}.pdf`,format:'pdf' as const,size:100,updatedAt:'2026-01-01',starred:false,folderId:null,lastOpenedAt:null})
afterEach(async()=>{await act(async()=>root.unmount());document.body.innerHTML=''})
async function mount(request:SettingsRequest){vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);document.body.innerHTML='<div id="trash-refill"></div>';root=createRoot(document.getElementById('trash-refill')!);await act(async()=>root.render(h(WorkspaceTrash,{request,presentation:'page',onClose(){},onChanged(){}})))}
const button=(text:string,scope:ParentNode=document)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!
async function mutate(id:string,action:'restore'|'purge'){
 const row=document.querySelector(`[data-row-key="${id}"]`)!
 if(action==='purge')await act(async()=>button('永久删除',row).click())
 await act(async()=>button(action==='restore'?'恢复':'确认永久删除',action==='restore'?row:document).click())
}
for(const action of ['restore','purge'] as const){
 test(`${action} on page one refills the shifted eleventh file before the last page disappears`,async()=>{
  let rows=Array.from({length:11},(_,index)=>file(index));const offsets:number[]=[],writes:string[]=[]
  await mount((async(path:string,method?:string)=>{if(method==='POST'){writes.push(path);rows=rows.filter(row=>row.id!=='file-0');return action==='purge'?{state:'purged'}:undefined}const offset=Number(new URL(path,'http://local').searchParams.get('offset'));offsets.push(offset);return {files:rows.slice(offset,offset+10),total:rows.length}}) as SettingsRequest)
  await mutate('file-0',action)
  expect(document.querySelector('[data-row-key="file-10"]')).not.toBeNull()
  expect(document.querySelectorAll('.ant-table-body [data-row-key]')).toHaveLength(10)
  expect(document.querySelector('[data-row-key="file-0"]')).toBeNull()
  expect(document.querySelector('.ant-pagination-item-2')).toBeNull()
  expect(offsets).toEqual([0,0]);expect(writes).toEqual([`/api/v1/files/file-0/${action}`])
 })
 test(`${action} remains confirmed when its page refill fails and an explicit reload never resends it`,async()=>{
  let rows=Array.from({length:11},(_,index)=>file(index)),written=false,readFails=true,writes=0
  await mount((async(path:string,method?:string)=>{if(method==='POST'){writes++;written=true;rows=rows.filter(row=>row.id!=='file-0');return action==='purge'?{state:'purged'}:undefined}if(written&&readFails)throw Error('read failed');return {files:rows.slice(0,10),total:rows.length}}) as SettingsRequest)
  await mutate('file-0',action)
  expect(document.body.textContent).toContain('操作已成功，但列表刷新失败')
  expect(document.body.textContent).toContain(action==='restore'?'已恢复':'已永久删除')
  expect(document.body.textContent).not.toContain('无法确认')
  expect(document.querySelector('[data-row-key="file-0"]')).toBeNull()
  readFails=false;await act(async()=>button('重新加载').click())
  expect(document.querySelector('[data-row-key="file-10"]')).not.toBeNull();expect(writes).toBe(1)
 })
 test(`${action} refill normalizes the page after concurrent removals shrink the server total`,async()=>{
  let rows=Array.from({length:21},(_,index)=>file(index));const offsets:number[]=[],writes:string[]=[]
  await mount((async(path:string,method?:string)=>{if(method==='POST'){writes.push(path);rows=rows.slice(0,5);return action==='purge'?{state:'purged'}:undefined}const offset=Number(new URL(path,'http://local').searchParams.get('offset'));offsets.push(offset);return {files:rows.slice(offset,offset+10),total:rows.length}}) as SettingsRequest)
  await act(async()=>document.querySelector<HTMLElement>('.ant-pagination-item-2 a')!.click());await mutate('file-10',action)
  expect(document.querySelector('.ant-pagination-item-active')?.textContent).toBe('1')
  expect(document.querySelectorAll('.ant-table-body [data-row-key]')).toHaveLength(5)
  expect(offsets).toEqual([0,10,10,0]);expect(writes).toEqual([`/api/v1/files/file-10/${action}`])
 })
}
