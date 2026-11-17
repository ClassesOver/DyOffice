import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {WorkspaceUploadDialog} from '../../src/shell/WorkspaceUploadDialog'
let root:Root
const previousAct=(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
afterEach(async()=>{await act(async()=>root?.unmount());document.body.innerHTML='';(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=previousAct})
async function mount(files:File[],upload:(file:File)=>Promise<void>,onClose=vi.fn()){
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 document.body.innerHTML='<div id="upload"></div>';root=createRoot(document.getElementById('upload')!)
 await act(async()=>root.render(h(WorkspaceUploadDialog,{open:true,initialFiles:files,upload,onClose})))
 return onClose
}
async function click(text:string){await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent===text)!.click()})}
test('upload validates formats before writes and keeps the queue inside a scrollable list',async()=>{
 const upload=vi.fn(async(_file:File)=>{})
 await mount([new File(['x'],'paper.DOCX'),new File(['x'],'unsafe.exe')],upload)
 expect(upload).not.toHaveBeenCalled()
 expect(document.querySelector('.workspace-upload-list')?.textContent).toContain('unsafe.exe')
 expect(document.body.textContent).toContain('不支持此格式')
 await click('开始上传（1）')
 expect(upload).toHaveBeenCalledTimes(1)
 expect(upload.mock.calls[0]?.[0].name).toBe('paper.DOCX')
 expect(document.body.textContent).toContain('已上传并打开')
 expect(document.querySelector('[role=progressbar]')).toBeNull()
})
test('upload processes files sequentially, prevents duplicate submits and continues after a failure',async()=>{
 let finish:(()=>void)|undefined
 const upload=vi.fn((file:File)=>file.name==='first.pdf'?new Promise<void>(resolve=>{finish=resolve}):file.name==='failed.xlsx'?Promise.reject(Error('网络中断，结果未知')):Promise.resolve())
 const onClose=await mount(['first.pdf','failed.xlsx','last.pptx'].map(name=>new File(['x'],name)),upload)
 await click('开始上传（3）')
 expect(upload).toHaveBeenCalledTimes(1)
 expect(document.querySelector<HTMLButtonElement>('.ant-modal-close')?.disabled).toBe(true)
 const submit=[...document.querySelectorAll('button')].find(button=>button.textContent?.includes('正在上传'))!
 expect(submit.disabled).toBe(true)
 await act(async()=>submit.click());expect(upload).toHaveBeenCalledTimes(1)
 await act(async()=>document.querySelector<HTMLButtonElement>('.ant-modal-close')!.click())
 expect(onClose).not.toHaveBeenCalled()
 await act(async()=>finish!())
 await vi.waitFor(()=>expect(upload).toHaveBeenCalledTimes(3))
 expect(upload.mock.calls.map(([file])=>file.name)).toEqual(['first.pdf','failed.xlsx','last.pptx'])
 expect(document.body.textContent).toContain('网络中断，结果未知')
 expect(document.body.textContent).toContain('请先核对工作区')
 expect(document.body.textContent).toContain('已完成 2')
 await click('完成');expect(onClose).toHaveBeenCalledOnce()
})
test('queued files can be removed before uploading',async()=>{
 const upload=vi.fn(async(_file:File)=>{})
 await mount([new File(['x'],'remove.pdf')],upload)
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="移除 remove.pdf"]')!.click())
 expect(document.querySelector('.workspace-upload-list')).toBeNull()
 expect(upload).not.toHaveBeenCalled()
})

test('the multi-file picker appends queued files and rejects oversized files before sending',async()=>{
 const upload=vi.fn(async(_file:File)=>{})
 const oversized=new File(['x'],'large.pdf');Object.defineProperty(oversized,'size',{value:32*1024*1024+1})
 await mount([new File(['x'],'initial.docx'),oversized],upload)
 const input=document.querySelector<HTMLInputElement>('input[type=file]')!
 expect(input.multiple).toBe(true)
 Object.defineProperty(input,'files',{configurable:true,value:[new File(['x'],'added.xlsx'),new File(['x'],'added.pptx')]})
 await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})))
 await vi.waitFor(()=>expect(document.querySelectorAll('.workspace-upload-item').length).toBe(4))
 expect(document.body.textContent).toContain('文件超过 32 MiB 限制')
 await click('开始上传（3）')
 expect(upload.mock.calls.map(([file])=>file.name)).toEqual(['initial.docx','added.xlsx','added.pptx'])
})

test('browser reload warns while uploading and releases the guard after completion or unmount',async()=>{
 let finish!:()=>void
 const reloadProtected=()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented}
 await mount([new File(['x'],'pending.pdf')],()=>new Promise<void>(resolve=>{finish=resolve}))
 expect(reloadProtected()).toBe(false)
 await click('开始上传（1）')
 expect(reloadProtected()).toBe(true)
 await act(async()=>finish())
 expect(reloadProtected()).toBe(false)
 await act(async()=>root.unmount())
 expect(reloadProtected()).toBe(false)
})
