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
 await vi.waitFor(()=>expect(document.body.textContent).toContain('report.docx'))
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

