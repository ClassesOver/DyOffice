import {useState} from 'react'
import {createAnalysisDeliveryClient} from '../../../../packages/browser-host/src/analysis-delivery-client.ts'
import {AnalysisDeliveryPanel} from './analysis-delivery-panel.tsx'
import {createAssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel.ts'
import {AssistantChannelPanel} from './assistant-channel-panel.tsx'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
import {createLocalShellClient} from '../shell/local-client'
import {createUserSkillsClient} from '../shell/user-skills-client'

export async function createEditorAssistant(channelOptions?:{fileId:string;editorId:string;generation:()=>number}) {
  const client = createLocalShellClient(), bound = await client.bindSession()
  const deliveries=createAnalysisDeliveryClient({request:bound.request,csrfToken:bound.proof})
  const assistant = await createAssistantClient({request: bound.request, csrfToken: bound.proof,onDelivery:(hint,agent)=>deliveries.observe(hint,agent)})
  const channel=assistant.catalog.assistantChannels&&channelOptions?createAssistantChannelClient({...channelOptions,request:bound.request}):undefined
  const skills = createUserSkillsClient(bound.request)
  function ModelPicker() {
    const [selected, setSelected] = useState(assistant.selected() ?? '')
    return <label className="ai-model-chip" title="切换模型后，下一条消息会开启新的模型上下文。">模型<select aria-label="助手模型" value={selected} onChange={e => {assistant.select(e.target.value); setSelected(e.target.value)}}>
      {assistant.catalog.entries.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
    </select></label>
  }
  function ChannelManager(){return <AssistantChannelPanel client={channel!} lang={document.documentElement.lang==='en'?'en':'zh'}/>}
  const noEvent = () => () => {}
  return {
    ...assistant,agents:assistant.catalog.agents??[],modelPicker:<><ModelPicker/>{channel&&<ChannelManager/>}{!!assistant.catalog.agents?.length&&<AnalysisDeliveryPanel client={deliveries} lang={document.documentElement.lang==='en'?'en':'zh'}/>}</>,
    channel,control:channel?.control,extraSkills:[...assistant.extraSkills,...(channel?[channel.skill]:[])],
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
      openSkillsSettings: async () => {location.assign('/')},
      openAiModelSettings: async () => {location.assign('/')},
    },
    dispose() {deliveries.dispose();channel?.dispose();assistant.dispose(); client.invalidateSession()},
  }
}
