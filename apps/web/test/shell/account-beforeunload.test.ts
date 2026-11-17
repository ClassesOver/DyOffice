import {afterEach,expect,test,vi} from 'vitest'
import {act,createElement as h} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {LocalPasswordForm} from '../../src/shell/LocalPasswordForm'
import {LocalSessionsPanel} from '../../src/shell/LocalSessionsPanel'
import {UserSkillsPanel} from '../../src/shell/UserSkillsPanel'
import {WorkspaceTrash} from '../../src/shell/WorkspaceTrash'
let root:Root
const environment=globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}
let previous:boolean|undefined
async function mount(node:ReturnType<typeof h>){previous=environment.IS_REACT_ACT_ENVIRONMENT;environment.IS_REACT_ACT_ENVIRONMENT=true;document.body.innerHTML='<div id="test"></div>';root=createRoot(document.getElementById('test')!);await act(async()=>root.render(node))}
afterEach(async()=>{await act(async()=>root?.unmount());environment.IS_REACT_ACT_ENVIRONMENT=previous;vi.restoreAllMocks();document.body.innerHTML=''})
function reloadProtected(){const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented}
async function click(label:string){await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent===label)!.click()})}
test('password dirty, pending and unknown protect browser reload without invoking confirmation',async()=>{
 let fail!:(error:Error)=>void;const confirm=vi.spyOn(window,'confirm')
 await mount(h(LocalPasswordForm,{changePassword:()=>new Promise<void>((_resolve,reject)=>{fail=reject}),reload:()=>{}}))
 expect(reloadProtected()).toBe(false)
 await act(async()=>{for(const [name,value] of [['currentPassword','current long password'],['newPassword','new valid long password'],['confirmation','new valid long password']]){const input=document.querySelector<HTMLInputElement>(`[name=${name}]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}})
 expect(reloadProtected()).toBe(true)
 await act(async()=>{document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))})
 expect(reloadProtected()).toBe(true)
 await act(async()=>fail(new Error('unknown')));expect(reloadProtected()).toBe(true);expect(confirm).not.toHaveBeenCalled()
 await act(async()=>root.unmount());expect(reloadProtected()).toBe(false)
})
for(const component of ['sessions','skills','trash'] as const)test(`${component} pending and unknown protect reload until successful reconciliation`,async()=>{
 let fail!:(error:Error)=>void
 const pending=()=>new Promise<void>((_resolve,reject)=>{fail=reject}),confirm=vi.spyOn(window,'confirm')
 const session={id:'other',current:false,createdAt:'2026-01-01',lastSeenAt:'2026-01-01',expiresAt:'2027-01-01'}
 const file={id:'file-a',name:'audit.docx',format:'docx',size:1,updatedAt:'2026-01-01',starred:false,folderId:null,lastOpenedAt:null}
 await mount(component==='sessions'?h(LocalSessionsPanel,{client:{list:async()=>[session],revoke:pending,revokeOthers:pending},onCurrentRevoked:()=>{}}):component==='skills'?h(UserSkillsPanel,{client:{listSkills:async()=>[],importText:pending} as never}):h(WorkspaceTrash,{request:(async(_path:string,method?:string)=>method==='POST'?pending():{files:[file],total:1}) as never,onClose:()=>{},onChanged:()=>{}}))
 expect(reloadProtected()).toBe(false)
 if(component==='sessions'){await click('撤销此会话');await click('确认撤销')}else if(component==='skills'){await click('安装')}else await click('恢复')
 expect(reloadProtected()).toBe(true)
 await act(async()=>fail(new Error('unknown')))
 expect(reloadProtected()).toBe(true);expect(confirm).not.toHaveBeenCalled()
 await click(component==='sessions'?'刷新会话列表':component==='skills'?'刷新列表':'重新加载')
 expect(reloadProtected()).toBe(false)
})
