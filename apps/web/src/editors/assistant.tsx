import {createFileChat} from './file-chat'
import {DocumentHandoffMessages} from './document-handoff'
import {Children,Fragment,isValidElement,useCallback,useEffect,useState,useSyncExternalStore,type ReactNode} from 'react'
import {createAnalysisDocumentRegistry} from '../../../../packages/browser-host/src/analysis-document-registry.ts'
import {createAnalysisDeliveryClient} from '../../../../packages/browser-host/src/analysis-delivery-client.ts'
import {ANALYSIS_INSERT_TOOLS,createAnalysisInsertSkill} from '../../../../packages/browser-host/src/analysis-insert-skill.ts'
import {AnalysisDeliveryPanel} from './analysis-delivery-panel.tsx'
import {createAssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel.ts'
import {createAssistantWorkspace} from '../../../../packages/browser-host/src/assistant-workspace.ts'
import {AssistantWorkspacePanel,AssistantTeamConversation} from './assistant-workspace-panel.tsx'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant.ts'
import {createLocalShellClient} from '../shell/local-client'
import {createWebAttachments} from './web-attachments'
import {createUserSkillsClient} from '../shell/user-skills-client'
import {AiModelPicker} from '@genoffice/ui'
import {configuredAiTool,createWebAiSearchApi,officeToolsWithConfiguredAiTools} from './web-ai-search-api.ts'
import {createWebAiMediaApi,createDocumentImageApi} from './web-ai-media-api.ts'
import {createPdfMediaSkill} from './pdf-media-skill.ts'
import type {PublicGlobalSettings} from '../../../../packages/web-contracts/src/settings.ts'

export type EditorAssistantFormat='docx'|'xlsx'|'pptx'|'pdf'
export async function createEditorAssistant(channelOptions?:{fileId:string;editorId:string;conversationId?:string;generation:()=>number;continuationRevision?:()=>string|undefined},readOnly=false,format:EditorAssistantFormat='docx',nativeToolNames?:ReadonlySet<string>,additionalSkills:readonly import('@genoffice/agent-core').AgentSkill[]=[]) {
  const client = createLocalShellClient(), bound = await client.bindSession()
  const accountName = bound.request<{user: {username: string; displayName?: string}}>('/api/v1/auth/me')
    .then(({user}) => user.username?.trim() || user.displayName?.trim() || '')
    .catch(() => '')
  const empty:ReturnType<ReturnType<typeof createFileChat>['read']>=[]
  function Conversation({children}: {children: ReactNode}) {
    const [name, setName] = useState('')
    useEffect(() => {
      let mounted = true
      void accountName.then(value => { if (mounted) setName(value) })
      return () => { mounted = false }
    }, [])
    const messages=useSyncExternalStore(fileChat?.subscribe??(()=>()=>{}),fileChat?.read??(()=>empty))
    const visible=(nodes:ReactNode):ReactNode[]=>Children.toArray(nodes).flatMap(node=>
      isValidElement<{children?:ReactNode;className?:string}>(node)&&node.type===Fragment?visible(node.props.children):
      messages.length&&isValidElement<{className?:string}>(node)&&node.props.className?.includes('ai-chat-empty')?[]:[node])
    return <AssistantTeamConversation client={workspace} lang={lang()} accountName={name}>
      {messages.map(m=><div key={m.turnId+':'+m.role} data-sender={m.sender} className={'ai-msg ai-msg-'+m.role} dir="auto" style={{whiteSpace:'pre-wrap'}}>
        {m.state==='failed'
          ? <>{m.text&&<span>{m.text}</span>}<small className="assistant-reply-status">{lang()==='zh'?'未完成':'Not completed'}</small></>
          : m.text||(m.state==='streaming'?(lang()==='zh'?'正在思考…':'Thinking…'):'')}
      </div>)}
      {format!=='docx'&&channelOptions&&<DocumentHandoffMessages fileId={channelOptions.fileId}/>}{visible(children)}
    </AssistantTeamConversation>
  }
  const attachments=createWebAttachments(bound.request,format)
  const documents=createAnalysisDocumentRegistry()
  const deliveries=createAnalysisDeliveryClient({request:bound.request,csrfToken:bound.proof})
  const baseTools=format==='pdf'?new Set([...(nativeToolNames??[]),'read_attachment']):nativeToolNames??new Set<string>()
  let publicSettings:PublicGlobalSettings|undefined
  try{publicSettings=await bound.request<PublicGlobalSettings>('/api/v1/settings/public')}catch{}
  const insertFormat=!readOnly&&(format==='docx'||format==='xlsx'||format==='pptx')?format:undefined
  // Analysis insertion runs through the editor's own fenced AnalysisDocumentTarget.
  const configuredTools=officeToolsWithConfiguredAiTools(insertFormat?new Set([...baseTools,...Object.values(ANALYSIS_INSERT_TOOLS)]):baseTools,publicSettings??{},format)
  const searchApi=createWebAiSearchApi(bound.request)
  const remoteMediaApi=createWebAiMediaApi(bound.request)
  const pdfImages=format==='pdf'?createDocumentImageApi({...remoteMediaApi,async generateImage(input,signal){
    const result=await remoteMediaApi.generateImage(input,signal)
    signal?.throwIfAborted()
    if(!result.url?.startsWith('data:'))return result
    const match=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(result.url)
    if(!match)return {error:'The generated image format is unsupported.'}
    const {normalizePdfGeneratedImage}=await import('./pdf-generated-image')
    const image=await normalizePdfGeneratedImage({mime:match[1]!,base64:match[2]!},signal)
    return {url:`data:${image.mime};base64,${image.base64}`}
  },async fetchImage(url,signal){
    const image=await remoteMediaApi.fetchImage(url,signal)
    signal?.throwIfAborted()
    if(!image)return null
    const {normalizePdfGeneratedImage}=await import('./pdf-generated-image')
    return normalizePdfGeneratedImage(image,signal)
  }}):undefined
  const mediaApi=pdfImages?{...remoteMediaApi,...pdfImages}:remoteMediaApi
  const pdfMediaSkill=format==='pdf'?createPdfMediaSkill({...(configuredTools.has('image_search')?{imageSearch:searchApi.imageSearch}:{}),...(configuredTools.has('generate_image')?{generateImage:mediaApi.generateImage}:{})}):undefined
  const mediaAnalysis={image:configuredAiTool(publicSettings??{},'image_analysis'),video:configuredAiTool(publicSettings??{},'video_analysis')}
  let taskStorage:Storage|undefined
  try{taskStorage=window.sessionStorage}catch{/* storage may be unavailable in an embedded editor */}
  const assistant = await createAssistantClient({format,nativeToolNames:configuredTools,mediaAnalysis,nativeDocumentEditing:!readOnly&&(format==='docx'||format==='pdf'),request: bound.request, csrfToken: bound.proof,
    ...(channelOptions?{documentId:channelOptions.fileId}:{}),...(taskStorage?{taskStorage}:{}),...(channelOptions?.continuationRevision?{continuationRevision:channelOptions.continuationRevision}:{}),onDelivery:(hint,agent)=>deliveries.observe(hint,agent)})
  let insertDisposed=false
  const analysisInsert=insertFormat?createAnalysisInsertSkill({format:insertFormat,request:bound.request,documents,deliveries,disposed:()=>insertDisposed,
    dataResults:()=>assistant.catalog.sourceMode==='read-only-analysis',images:()=>!!assistant.coding}):undefined
  const fileChat=channelOptions?createFileChat(channelOptions.fileId,assistant.transport,bound.request):undefined
  const conversationId=channelOptions?.conversationId??new URLSearchParams(location.search).get('channel')??undefined
  const channel=assistant.catalog.assistantChannels&&channelOptions&&conversationId
    ?createAssistantChannelClient({...channelOptions,conversationId,request:bound.request}):undefined
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
  async function connectChannel(){
    try{await channel!.start();return channel!.connected()&&!channel!.error()}catch{return false}
  }
  const initialConnection=channel?connectChannel():undefined
  function ChannelConnection(){
    const [state,setState]=useState<'connecting'|'connected'|'failed'>('connecting')
    const connect=useCallback(async()=>{
      setState('connecting')
      setState(await connectChannel()?'connected':'failed')
    },[])
    useEffect(()=>{
      const unsubscribe=channel!.subscribe(()=>{
        if(channel!.error())setState('failed')
        else if(channel!.connected())setState('connected')
        else if(!channel!.snapshot())setState('failed')
      })
      let active=true
      void initialConnection!.then(ok=>{if(active)setState(ok&&channel!.connected()&&!channel!.error()?'connected':'failed')})
      return()=>{active=false;unsubscribe()}
    },[])
    if(state==='connected')return null
    const zh=lang()==='zh'
    return <div className="assistant-channel-connection"><span role="status">{state==='connecting'?(zh?'正在接入协作频道…':'Connecting to channel…'):(zh?'协作频道未连接':'Channel disconnected')}</span>
      {state==='failed'&&<button type="button" onClick={()=>void connect()}>{zh?'重试连接':'Retry connection'}</button>}
    </div>
  }
  // Native hosts load preferences after binding the assistant, before rendering.
  function WorkspacePanel(){
    const language=lang()
    return <AssistantWorkspacePanel client={workspace} lang={language} channelConnection={channel&&<ChannelConnection/>}
      deliveries={(!!assistant.catalog.agents?.length||assistant.catalog.assistantChannels&&channelOptions)&&<AnalysisDeliveryPanel client={deliveries} documents={documents} lang={language}/>}/>
  }
  const noEvent = () => () => {}
  return {
    request:bound.request,sessionProof:bound.proof,
    ...assistant,agents:assistant.catalog.agents??[],modelPicker:<ModelPicker/>,fileChat,continuationRevision:channelOptions?.continuationRevision,
    workspace:{conversation:(children:ReactNode)=><Conversation>{children}</Conversation>,isOffice:workspace.isOffice,submit:workspace.submit,panel:<WorkspacePanel/>},
    documents,channel,searchApi,mediaApi,mediaCapabilities:{imageGeneration:configuredTools.has('generate_image'),mediaAnalysis:configuredTools.has('analyze_media'),imageAnalysis:mediaAnalysis.image},control:channel?.control,extraSkills:[...assistant.extraSkills,...additionalSkills,...(pdfMediaSkill?[pdfMediaSkill]:[]),...(analysisInsert?[analysisInsert]:[]),...(channel?[channel.skill]:[])],
    api: {
      // Local compatibility projection only. Full desktop settings and global
      // credentials never travel over HTTP or enter this renderer.
      getAiSettings: async () => ({provider: 'openai' as const, providers: {openai: {apiKey: '', model: 'server-managed'}}}),
      setAiSettings: async () => {throw new Error('请在首页由管理员管理模型。')},
      onAiSettingsChanged: noEvent,
      aiGskStatus: async () => ({loggedIn: false}),
      ...searchApi,
      ...mediaApi,
      skillsList: skills.listSkills, skillText: skills.skillText,
      pickAttachments: attachments.pickAttachments,
      addAttachmentFiles: attachments.addFiles,
      getPathForFile: attachments.getPathForFile,
      getAttachmentFile: attachments.getFileForPath,
      addAttachmentPaths: attachments.addAttachmentPaths,
      addPastedImage: attachments.addPastedImage,
      readAttachment: attachments.readAttachment,
      readAttachmentImage: attachments.readAttachmentImage,
      openSkillsSettings: () => openSettings('skills'),
      openAiModelSettings: () => openSettings('models'),
    },
    dispose() {insertDisposed=true;fileChat?.dispose();pdfImages?.dispose();attachments.dispose();workspace.dispose();documents.dispose();deliveries.dispose();channel?.dispose();assistant.dispose(); client.invalidateSession()},
  }
}
