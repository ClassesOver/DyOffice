import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {ManagementList} from '../../src/shell/ManagementList'
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root
const callbacks:ResizeObserverCallback[]=[]
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML='';vi.unstubAllGlobals();callbacks.length=0})
test('management list resizes only its table viewport and keeps toolbar and pagination outside the scrolling body',async()=>{
 vi.stubGlobal('ResizeObserver',class{constructor(callback:ResizeObserverCallback){callbacks.push(callback)}observe(){}unobserve(){}disconnect(){}})
 document.body.innerHTML='<div id="list"></div>';root=createRoot(document.getElementById('list')!)
 await act(async()=>root.render(h(ManagementList<{id:string}>,{rowKey:'id',summary:'20 项',toolbar:h('button',null,'刷新'),dataSource:Array.from({length:20},(_,i)=>({id:String(i)})),columns:[{title:'名称',dataIndex:'id'}],pagination:{current:1,pageSize:10,total:20}})))
 const region=document.querySelector('.management-list-table-region')!
 await act(async()=>{for(const callback of callbacks)callback([{target:region,contentRect:{height:320}}] as never,{} as ResizeObserver)})
 expect(document.querySelector<HTMLElement>('.ant-table-body')?.style.maxHeight).toBe('260px')
 expect(region.contains(document.querySelector('.management-list-toolbar'))).toBe(false)
 expect(region.contains(document.querySelector('.ant-pagination'))).toBe(false)
 await act(async()=>{for(const callback of callbacks)callback([{target:region,contentRect:{height:200}}] as never,{} as ResizeObserver)})
 expect(document.querySelector<HTMLElement>('.ant-table-body')?.style.maxHeight).toBe('140px')
})
