import {useState} from 'react'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
import {createLocalShellClient} from '../shell/local-client'
import {createUserSkillsClient} from '../shell/user-skills-client'

export async function createEditorAssistant() {
  const client = createLocalShellClient(), bound = await client.bindSession()
  const assistant = await createAssistantClient({request: bound.request, csrfToken: bound.proof})
  const skills = createUserSkillsClient(bound.request)
  function ModelPicker() {
    const [selected, setSelected] = useState(assistant.selected() ?? '')
    return <label className="ai-model-chip" title="切换模型后，下一条消息会开启新的模型上下文。">模型<select aria-label="助手模型" value={selected} onChange={e => {assistant.select(e.target.value); setSelected(e.target.value)}}>
      {assistant.catalog.entries.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
    </select></label>
  }
  const noEvent = () => () => {}
  return {
    ...assistant, modelPicker: <ModelPicker/>,
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
    dispose() {assistant.dispose(); client.invalidateSession()},
  }
}
