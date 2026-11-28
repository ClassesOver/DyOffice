import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {WorkspaceUploadDialog} from '../../src/shell/WorkspaceUploadDialog'
import {createLocalShellClient} from '../../src/shell/local-client'
let root:Root
const previousAct=(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT
;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
afterEach(async()=>{await act(async()=>root?.unmount());document.body.innerHTML='';(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=previousAct})
async function mount(files:File[],upload:(file:File,password?:string)=>Promise<void|'password-required'>,onClose=vi.fn()){
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 document.body.innerHTML='<div id="upload"></div>';root=createRoot(document.getElementById('upload')!)
 await act(async()=>root.render(h(WorkspaceUploadDialog,{open:true,initialFiles:files,upload,onClose})))
 return onClose
}
async function click(text:string){await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent===text)!.click()})}
const encryptedWorkbook=new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,0x23])

test('the workspace prompts before sending an encrypted XLSX, retries incorrect passwords and can skip the next encrypted file',async()=>{
 const proof='p'.repeat(43),secrets:string[]=[],formats:string[]=[],staged:string[]=[]
 const client=createLocalShellClient(async(input,options)=>{
  const path=String(input)
  if(path.endsWith('/session-proof'))return Response.json({csrfToken:proof})
  if(path==='/api/v1/files/uploads'){
   const {name,size}=JSON.parse(String(options?.body));staged.push(name)
   expect(size).toBe(name.endsWith('.XLSX')?encryptedWorkbook.length:3)
   return Response.json({uploadId:String(staged.length)})
  }
  if(path.endsWith('/content')){
   const type=new Headers(options?.headers).get('content-type')!
   formats.push(type)
   if(type==='application/vnd.dyoffice.encrypted-xlsx'){
    const body=await (options?.body as Blob).arrayBuffer()
    const length=new DataView(body).getUint16(0)
    const secret=new TextDecoder().decode(body.slice(2,2+length));secrets.push(secret)
    expect(new Uint8Array(body.slice(2+length))).toEqual(encryptedWorkbook)
    expect(new Headers(options?.headers).get('x-csrf-token')).toBe(proof)
    if(secret==='wrong')return Response.json({code:'WORKBOOK_PASSWORD_INVALID'},{status:422})
   }
   return Response.json({})
  }
  if(path.endsWith('/finish'))return Response.json({file:{fileId:path},format:'xlsx'})
  throw new Error('Unexpected request '+path)
 })
 const first=new File([encryptedWorkbook],'first.XLSX'),skipped=new File([encryptedWorkbook],'skip.xlsx')
 await mount([first,skipped,new File(['pdf'],'last.pdf')],async(file,password)=>{await client.upload(file,proof,false,password)})
 await click('开始上传（3）')
 const input=()=>document.querySelector<HTMLInputElement>('input[type=password]')
 await vi.waitFor(()=>expect(input()).not.toBeNull())
 expect(staged).toEqual([])
 const fill=async(value:string)=>act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input(),value)
  input()!.dispatchEvent(new Event('input',{bubbles:true}))
 })
 await fill('wrong');await click('确认密码')
 await vi.waitFor(()=>expect(document.querySelector('[role=alert]')?.textContent).toContain('工作簿密码错误'))
 expect(input()?.value).toBe('')
 await fill('  表格🔑 ');await click('确认密码')
 await vi.waitFor(()=>expect(document.querySelector('label[for="workspace-upload-password"]')?.textContent).toContain('skip.xlsx'))
 await click('跳过此文件')
 await vi.waitFor(()=>expect(document.body.textContent).toContain('已完成 2'))
 expect(staged).toEqual(['first.XLSX','first.XLSX','last.pdf'])
 expect(secrets).toEqual(['wrong','  表格🔑 '])
 expect(formats).toEqual(['application/vnd.dyoffice.encrypted-xlsx','application/vnd.dyoffice.encrypted-xlsx','application/octet-stream'])
 expect(document.body.textContent).toContain('已跳过')
})

test('an imported workbook that still needs an editor unlock is counted as uploaded',async()=>{
 await mount([new File([encryptedWorkbook],'locked.xlsx')],async()=> 'password-required')
 await click('开始上传（1）')
 await vi.waitFor(()=>expect(document.querySelector('input[type=password]')).not.toBeNull())
 const input=document.querySelector<HTMLInputElement>('input[type=password]')!
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'password')
  input.dispatchEvent(new Event('input',{bubbles:true}))
 })
 await click('确认密码')
 expect(document.body.textContent).toContain('已上传，请在编辑器中解锁')
 expect(document.body.textContent).toContain('已完成 1')
 expect(document.body.textContent).not.toContain('部分文件未完成导入')
})
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

test('TSV uploads convert within the bound session and stage the XLSX copy',async()=>{
 const proof='p'.repeat(43),staged:string[]=[]
 const input=new File(['Name\tValue\nA, B\t42'],'Report.TSV')
 const converted=new Blob(['converted workbook'],{type:'application/octet-stream'})
 const client=createLocalShellClient(async(request,options)=>{
  const path=String(request)
  if(path.endsWith('/session-proof'))return Response.json({csrfToken:proof})
  expect(new Headers(options?.headers).get('x-csrf-token')).toBe(proof)
  if(path.endsWith('/convert-tsv')){
   expect(await (options?.body as Blob).text()).toBe(await input.text())
   return Object.assign(new Response(null,{headers:{'content-type':'application/octet-stream'}}),{blob:async()=>converted})
  }
  if(path.endsWith('/uploads')){
   const {name,size}=JSON.parse(String(options?.body));staged.push(name)
   expect(size).toBe(converted.size)
   return Response.json({uploadId:'upload'})
  }
  if(path.endsWith('/content')){
   expect(await (options?.body as Blob).text()).toBe(await converted.text())
   return Response.json({})
  }
  if(path.endsWith('/finish'))return Response.json({file:{fileId:'file'},format:'xlsx'})
  throw new Error('Unexpected request '+path)
 })
 await client.upload(input,proof)
 expect(staged).toEqual(['Report.xlsx'])
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

test('the picker supports Space without scrolling and preserves single Enter and click activation',async()=>{
 await mount([],async()=>{})
 const target=document.querySelector<HTMLElement>('.ant-upload-btn[role="button"]')!
 const input=document.querySelector<HTMLInputElement>('input[type=file]')!
 const picker=vi.spyOn(input,'click').mockImplementation(()=>{})
 target.focus()
 const space=new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true})
 await act(async()=>target.dispatchEvent(space))
 expect(space.defaultPrevented).toBe(true)
 expect(picker).toHaveBeenCalledTimes(1)
 await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:' ',repeat:true,bubbles:true,cancelable:true})))
 expect(picker).toHaveBeenCalledTimes(1)
 await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})))
 expect(picker).toHaveBeenCalledTimes(2)
 await act(async()=>target.click())
 expect(picker).toHaveBeenCalledTimes(3)
 picker.mockRestore()
})

test('recent documents open by workspace ID while a failed open leaves the list available',async()=>{
 const loadRecent=vi.fn(async()=>[{path:'file-id',name:'Recent.pdf',locationLabel:'Reports'}])
 const openRecent=vi.fn<(id:string)=>Promise<void>>().mockRejectedValueOnce(new Error('文件已移入回收站')).mockResolvedValueOnce(undefined)
 const onClose=vi.fn()
 ;(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true
 document.body.innerHTML='<div id="upload"></div>';root=createRoot(document.getElementById('upload')!)
 await act(async()=>root.render(h(WorkspaceUploadDialog,{open:true,upload:vi.fn(),onClose,loadRecent,openRecent})))
 expect(loadRecent).not.toHaveBeenCalled()
 await click('最近打开')
 expect(loadRecent).toHaveBeenCalledOnce()
 const recent=()=>document.querySelector<HTMLButtonElement>('button[title="Recent.pdf"]')!
 await act(async()=>recent().click())
 expect(openRecent).toHaveBeenCalledExactlyOnceWith('file-id')
 expect(document.body.textContent).toContain('文件已移入回收站')
 expect(onClose).not.toHaveBeenCalled()
 await act(async()=>recent().click())
 expect(onClose).toHaveBeenCalledOnce()
})
