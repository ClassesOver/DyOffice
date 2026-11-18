import {expect,test,vi} from 'vitest'
import {act,createElement as h,useEffect} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from '../../src/shell/WorkspaceSettings'
test('host-requested skills tab preserves existing personal preference drafts and their close guard',async()=>{
 const prefs={theme:'light' as const,language:'zh' as const,authorName:'Original',autoSave:false,showAssistant:true}
 let skillsBlocked=true
 function Skills({register}:{register:(guard:(()=>boolean)|null)=>void}){useEffect(()=>{register(()=>!skillsBlocked);return()=>register(null)},[register]);return h('p',null,'Personal skills content')}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let guard:(()=>boolean)|null=null
 const props={user:{username:'alice',displayName:'Alice',roles:['personal']},load:async()=>prefs,save:async()=>prefs,sessionsClient:{listPage:async()=>({sessions:[],nextCursor:null}),list:async()=>[],revoke:async()=>{},revokeOthers:async()=>{}},historyClient:{list:async()=>[],listPage:async()=>({events:[],nextCursor:null})},security:{changePassword:async()=>{},onCurrentRevoked(){}},skills:(register:(guard:(()=>boolean)|null)=>void)=>h(Skills,{register}),onClose(){},onLogout(){},onCloseGuardChange:(value:(()=>boolean)|null)=>{guard=value}}
 const before=(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 try{
  await act(async()=>root.render(h(WorkspaceSettings,props)))
  expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('账户与安全')
  await act(async()=>root.render(h(WorkspaceSettings,{...props,activeTab:'general'})))
  const author=host.querySelector<HTMLInputElement>('[aria-label="文档作者"]')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(author,'Unsaved author');author.dispatchEvent(new Event('input',{bubbles:true}))})
  expect(guard?.()).toBe(false)
  await act(async()=>root.render(h(WorkspaceSettings,{...props,activeTab:'skills'})))
  expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('个人技能')
  expect(host.querySelector<HTMLInputElement>('[aria-label="文档作者"]')?.value).toBe('Unsaved author')
  expect(host.querySelector('[aria-label="文档作者"]')).toBe(author)
  expect(guard?.()).toBe(false)
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(author,'Original');author.dispatchEvent(new Event('input',{bubbles:true}))})
  expect(guard?.()).toBe(false)
  skillsBlocked=false;expect(guard?.()).toBe(true)
 }finally{await act(async()=>root.unmount());host.remove();confirm.mockRestore();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:before})}
})
