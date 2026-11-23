import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,test,vi} from 'vitest'
import type {ComponentProps} from 'react'
vi.mock('../../../sheets/src/renderer/i18n/locale',()=>({useI18n:()=>({lang:'zh',t:(key:string)=>key})}))
vi.mock('@genoffice/ui',async importOriginal=>({
 ...await importOriginal<typeof import('@genoffice/ui')>(),
 AiComposer:()=>null,AiSkillChips:()=>null,AiSkillsMenu:()=>null,AiModelPicker:()=>null,
}))
import {AiChatPanel} from '../../../sheets/src/renderer/ai/AiChatPanel'

test('XLSX assistant can open, collapse, hide its rail and reopen without changing hook order',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const noop=()=>{}
 const props:ComponentProps<typeof AiChatPanel>={isOpen:false,hasContent:true,chat:[],attachments:[],attachedSkills:[],attachNotice:null,prompt:'',preview:null,aiBusy:false,scopeRange:null,scopeColumns:null,scopeLocked:false,modelPicker:h('span',null,'model'),onToggleSkill:noop,onPickAttachments:noop,onAddAttachmentPaths:noop,onAddPastedImage:noop,onRemoveAttachment:noop,onPromptChange:noop,onSend:noop,onStop:noop,onNewChat:noop,onUndo:noop,onScopeDismiss:noop,onCitation:noop,onExpand:noop,onCollapse:noop}
 const container=document.createElement('div');document.body.append(container)
 const root=createRoot(container)
 try{
  for(const state of [{isOpen:false},{isOpen:true},{isOpen:false},{isOpen:false,hideRail:true},{isOpen:true,hideRail:true}]){
   await act(async()=>root.render(h(AiChatPanel,{...props,...state})))
   expect(container.querySelector('.ai-panel-header')!==null).toBe(state.isOpen)
  }
 }finally{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals()}
})
