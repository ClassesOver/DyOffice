import {test,expect,vi} from 'vitest'
import {createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceTrash} from '../../src/shell/WorkspaceTrash'

test('recycle bin retains failed restoration and prevents duplicate clicks until explicit reconciliation',async()=>{
 document.body.innerHTML='<div id="trash-test"></div>'
 let writes=0;let finish:(v:unknown)=>void=()=>{};let reject:(error:Error)=>void=()=>{}
 const row={id:'file-a',name:'report.docx',format:'docx',size:12,updatedAt:'2026-01-01',starred:true,folderId:null,lastOpenedAt:null}
 const request=vi.fn(async(_path:string,method?:string)=>method==='POST'?(writes++,new Promise((resolve,fail)=>{finish=resolve;reject=fail})):{files:[row],total:1})
 const root=createRoot(document.querySelector('#trash-test')!)
 root.render(h(WorkspaceTrash,{request:request as never,onClose(){},onChanged(){}}))
 await vi.waitFor(()=>expect(document.body.textContent).toContain('report.docx'),{timeout:3000})
 const restore=()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='恢复')!
 restore().click();restore().click();await vi.waitFor(()=>expect(writes).toBe(1))
 reject(new Error('lost response'))
 await vi.waitFor(()=>expect(document.querySelector('[role="alert"]')?.textContent).toContain('重新加载'))
 expect(document.body.textContent).toContain('report.docx');expect(restore().disabled).toBe(true)
 ;([...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='重新加载')!).click()
 await vi.waitFor(()=>expect(restore().disabled).toBe(false));restore().click()
 await vi.waitFor(()=>expect(writes).toBe(2));finish(undefined)
 root.unmount()
})

test('permanent deletion uses the shared B dialog portal and cancel never mutates',async()=>{
 const host=document.createElement('div');document.body.append(host)
 const row={id:'file-a',name:'report.docx',format:'docx',size:12,updatedAt:'2026-01-01',starred:false,folderId:null,lastOpenedAt:null}
 const request=vi.fn(async()=>({files:[row],total:1})),root=createRoot(host)
 try{
  root.render(h(WorkspaceTrash,{request:request as never,presentation:'page',onClose(){},onChanged(){}}))
  await vi.waitFor(()=>expect(host.textContent).toContain('report.docx'))
  ;([...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='永久删除')!).click()
  await vi.waitFor(()=>expect(document.querySelector('[role=dialog]')).not.toBeNull())
  const dialog=document.querySelector('[role=dialog]')!
  expect(dialog.classList.contains('settings-dialog-b')).toBe(true)
  expect(dialog.textContent).toContain('此操作无法恢复')
  ;([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='取消')!).click()
  // AntD keeps the portal for its leave animation; verify closing starts.
  await vi.waitFor(()=>expect(dialog.className).toContain('ant-zoom-leave'))
  expect(request.mock.calls).toHaveLength(1)
 }finally{root.unmount();host.remove()}
})
