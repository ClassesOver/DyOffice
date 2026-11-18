import {useEffect,useState,type ReactNode,type KeyboardEvent} from 'react'
import {createAnalysisDocumentRegistry} from '../../../../packages/browser-host/src/analysis-document-registry.ts'
import {createAnalysisDeliveryClient} from '../../../../packages/browser-host/src/analysis-delivery-client.ts'
import {AnalysisDeliveryPanel} from './analysis-delivery-panel.tsx'
import {createAssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel.ts'
import {AssistantChannelPanel} from './assistant-channel-panel.tsx'
import {createAssistantWorkspace} from '../../../../packages/browser-host/src/assistant-workspace.ts'
import {AssistantWorkspacePanel,AssistantRecipient,AssistantTeamConversation,handleTeamMentionKey} from './assistant-workspace-panel.tsx'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
import {createLocalShellClient} from '../shell/local-client'
import {createUserSkillsClient} from '../shell/user-skills-client'
import {AiModelPicker} from '@genoffice/ui'

export async function createEditorAssistant(channelOptions?:{fileId:string;editorId:string;generation:()=>number}) {
  const client = createLocalShellClient(), bound = await client.bindSession()
  const documents=createAnalysisDocumentRegistry()
  const deliveries=createAnalysisDeliveryClient({request:bound.request,csrfToken:bound.proof})
  const assistant = await createAssistantClient({nativeDocumentEditing:true,request: bound.request, csrfToken: bound.proof,onDelivery:(hint,agent)=>deliveries.observe(hint,agent)})
  const channel=assistant.catalog.assistantChannels&&channelOptions?createAssistantChannelClient({...channelOptions,request:bound.request}):undefined
  const workspace=createAssistantWorkspace({agents:assistant.catalog.agents??[],coding:assistant.coding?{...assistant.coding,run:(input,signal)=>assistant.coding!.run(input,signal,assistant.selected(),'user')}:undefined,channel})
  const lang=()=>document.documentElement.lang.startsWith('en')?'en' as const:'zh' as const
  const skills = createUserSkillsClient(bound.request)
  async function openSettings(target:'skills'|'models') {
    try {
      const host=window.parent as Window & {dyofficeOpenEditorSettings?:(target:'skills'|'models',source:Window)=>void}
      if(host===window||host.location.origin!==window.location.origin||!host.dyofficeOpenEditorSettings)throw Error('请从工作区打开文档，再管理个人技能或模型配置。')
      host.dyofficeOpenEditorSettings(target,window)
    } catch {window.alert('配置入口不可用，请从工作区打开文档后再试。')}
  }

  function ModelPicker() {
    const [selected, setSelected] = useState(assistant.selected() ?? '')
    const [,update]=useState(0)
    useEffect(()=>workspace.subscribe(()=>update(value=>value+1)),[])
    if(workspace.snapshot().selected.kind==='channel')return <span className="editor-model-external">{lang()==='en'?'Model managed externally':'模型由外接助手管理'}</span>
    return <AiModelPicker
      bridge={{getSettings: async () => {throw new Error('server-managed model catalog')}, setSettings: async () => {}, openModelSettings: () => openSettings('models')}}
      lang={lang()}
      catalogEntries={assistant.catalog.entries}
      selectedId={selected}
      onCatalogSelect={id => {assistant.select(id); setSelected(id)}}
    />
  }
  function ChannelMembers(){return <AssistantChannelPanel client={channel!} lang={lang()} mode="members"/>}
  function ChannelTasks(){return <AssistantChannelPanel client={channel!} lang={lang()} mode="tasks"/>}
  // Native hosts load preferences after binding the assistant, before rendering.
  function DeliveryManager(){return <AnalysisDeliveryPanel client={deliveries} documents={documents} lang={document.documentElement.lang==='en'?'en':'zh'}/>}
  const noEvent = () => () => {}
  return {
    ...assistant,agents:assistant.catalog.agents??[],modelPicker:<ModelPicker/>,
    workspace:{conversation:(children:ReactNode)=><AssistantTeamConversation client={workspace} lang={lang()}>{children}</AssistantTeamConversation>,renderRecipient:(draft:string,onDraftChange:(value:string)=>void)=><AssistantRecipient client={workspace} lang={lang()} draft={draft} onDraftChange={onDraftChange}/>,handleComposerKeyDown:(event:KeyboardEvent,draft:string,onChange:(value:string)=>void)=>handleTeamMentionKey(workspace,event,draft,onChange),isOffice:workspace.isOffice,submit:workspace.submit,panel:<AssistantWorkspacePanel client={workspace} lang={lang()} channelMembers={channel&&<ChannelMembers/>} channelTasks={channel&&<ChannelTasks/>} deliveries={(!!assistant.catalog.agents?.length||channel)&&<DeliveryManager/>}/>,recipient:<AssistantRecipient client={workspace} lang={lang()}/>},
    documents,channel,control:channel?.control,extraSkills:[...assistant.extraSkills,...(channel?[channel.skill]:[])],
    api: {
      // Local compatibility projection only. Full desktop settings and global
      // credentials never travel over HTTP or enter this renderer.
      getAiSettings: async () => ({provider: 'openai' as const, providers: {openai: {apiKey: '', model: 'server-managed'}}}),
      setAiSettings: async () => {throw new Error('请在首页由管理员管理模型。')},
      onAiSettingsChanged: noEvent,
      aiGskStatus: async () => ({loggedIn: false}),
      skillsList: skills.listSkills, skillText: skills.skillText,
      pickAttachments: async () => ({attachments: [], rejected: []}),
      getPathForFile: () => '',
      openSkillsSettings: () => openSettings('skills'),
      openAiModelSettings: () => openSettings('models'),
    },
    dispose() {workspace.dispose();documents.dispose();deliveries.dispose();channel?.dispose();assistant.dispose(); client.invalidateSession()},
  }
}
