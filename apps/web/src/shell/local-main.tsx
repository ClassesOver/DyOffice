import {WorkspaceLoading} from './WorkspaceLoading'
import {HomeHero} from './HomeHero'
import type {PreparedAiDocumentCreator} from './pdf-create-document-skill'
import {createAiDocCreationQueue,type AiDocCreationResult} from './ai-doc-creation'
import {isRevisionRef,type RevisionRef} from '../../../../packages/web-contracts/src/api'
import {AssistantChannelsPage} from './AssistantChannelsPage'
import {BackgroundTasksPage} from './BackgroundTasksPage'
import React,{useEffect,useState,useCallback,useRef} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from './WorkspaceSettings'
import {NativeSettingsDialog} from './NativeSettingsDialog'
import {WorkspaceUploadDialog} from './WorkspaceUploadDialog'
import {AppFrame} from '../../../shell/src/renderer/src/AppFrame'

import {LocaleProvider} from '../../../shell/src/renderer/src/locale'
import type {TabsApi} from '../../../shell/src/shared/tabs-api'
import {notifyFilesChanged} from '../../../shell/src/renderer/src/file-events'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ai-model-picker.css'
import '@genoffice/ui/ai-usage.css'
import '@genoffice/ui/ai-skills.css'
import '../../../shell/src/renderer/src/home.css'
import '../../../shell/src/renderer/src/tabbar.css'
import './web-shell.css'
import {installScreenTips} from '@genoffice/ui'
import {createLocalHomeBridge} from './local-home-bridge'
import {createLocalPreferencesSession} from './local-preferences-session'
import {createLocalGlobalSettingsSession} from './local-global-settings-session'
import {GlobalSettingsPanel} from './GlobalSettingsPanel'
import {WorkspaceTrash} from './WorkspaceTrash'
import {createUserSkillsClient} from './user-skills-client'
import {UserSkillsPanel} from './UserSkillsPanel'
import {SourcesPanel} from './SourcesPanel'
import {WorkspaceDataResults} from './WorkspaceDataResults'
import {createSourceWorkspaceSession} from './source-workspace-session'
import blankDocx from '../../../shell/build/shell-new/blank.docx?url'
import blankXlsx from '../../../shell/build/shell-new/blank.xlsx?url'
import blankPptx from '../../../shell/build/shell-new/blank.pptx?url'
import {createLocalNewSheet,createLocalNewSlide,createLocalNewPdf,localNewFormats,openCreatedDocument} from './local-new-sheet'

import {hideAccountRecoveryPortals} from './account-recovery-portals'
import {createLocalShellClient,type SessionEndReason} from './local-client'
import {createLocalAdminClient} from './local-admin-client'
import {createLocalSessionsClient} from './local-sessions-client'
import {createLocalWorkspaceSession} from './local-workspace-session'
import {createLoginHistoryClient} from './local-login-history-client'
import {ConfigProvider,theme as antdTheme,Dropdown,Button,Alert,Form,Input,Card,Typography} from 'antd'
import logo from '../../../shell/src/renderer/src/assets/dyoffice-logo.svg'
import zhCN from 'antd/locale/zh_CN'
const workspacePages={channels:'频道分享',tasks:'后台任务',settings:'个人设置',trash:'回收站',results:'数据结果',sources:'数据连接',global:'全局配置',users:'用户管理'} as const
type WorkspacePage=keyof typeof workspacePages
import {AccountMenu} from './AccountMenu'
import {CitationTabUnverified,createDocumentTabs,type DocumentFormat} from './document-tabs'
import {resolvedDocument,readOpenDocument} from './document-entry-reader'
import {CitedRevisionChanged} from '../../../../packages/browser-host/src/session-files'
import {createEntryNavigator} from './workspace-entry-navigation'
import {createEntryRecovery,entryHash,parseEntryHash,resolveEntrySnapshot} from './workspace-entry-recovery'
import {DocumentFrame} from './DocumentFrame'
import {DocumentPreview} from './DocumentPreview'
import './workspace-shell.css'
import './home-entry-b.css'
import {LocalAdminPanel} from './LocalAdminPanel'
import {PasswordActionForm} from './PasswordActionForm'
import './config-polish.css'
import './personal-config-polish.css'
import './configuration-theme.css'
const client=createLocalShellClient()
const adminClient=createLocalAdminClient(fetch,()=>client.endSession('expired'))
const workspaceSession=createLocalWorkspaceSession(client)
const sessionsClient=createLocalSessionsClient(workspaceSession.sessionFetch,()=>client.endSession('expired'))
const historyClient=createLoginHistoryClient(fetch,()=>client.endSession('expired'))
const preferenceSession=createLocalPreferencesSession(client)
const preferences=preferenceSession.preferences
const globalSettingsSession=createLocalGlobalSettingsSession(client)
const globalSettings=globalSettingsSession.settings
let userSkills: ReturnType<typeof createUserSkillsClient> | undefined
let sourceWorkspace: Awaited<ReturnType<typeof createSourceWorkspaceSession>> | undefined
type User={id:string;username:string;displayName:string;roles:string[]}
let user:User|null=null
let initialLanguage:'zh'|'en'='zh'
let notice=(message:string)=>window.alert(message)
let showTrash=()=>{}
let showUpload=(_files:File[]=[])=>{}
let capabilities:Record<string,string>={}
let showChromeMenu=(kind:'app'|'new'|'tabs'|'tab',x:number,y:number,id?:string)=>{}
const surface=(id:string)=>[...document.querySelectorAll<HTMLElement>('.workspace-document[data-file-id]')].find(item=>item.dataset.fileId===id)
const nativeFrame=(element:HTMLElement|undefined)=>element?.querySelector<HTMLIFrameElement>('.workspace-document-frame')
const documentTabs=createDocumentTabs({
 displayedRevision(id){
  const element=surface(id),frame=nativeFrame(element)
  return frame?.contentWindow?.dyofficeDisplayedRevision?.()??element?.querySelector<HTMLElement>('[data-preview-revision]')?.dataset.previewRevision
 },
 isCitationExpired(id){
  const element=surface(id)
  return nativeFrame(element)?.contentDocument?.documentElement.dataset.documentLoading==='citation-expired'||!!element?.querySelector('[data-citation-expired="true"]')
 },
})
function updateAutoPdfTab(id:string,previous:string,name:string){
 const file=documentTabs.renderedDocuments().find(item=>item.id===id)
 if(file?.format==='pdf'&&file.name===previous)documentTabs.rename(id,name)
 notifyFilesChanged()
}
const pendingAiDocContents=createAiDocCreationQueue()
declare global {
 interface Window {
  dyofficeCompleteAiDocContent?:(fileId:string,result:AiDocCreationResult)=>void
  dyofficeConsumeAiDocContent?:(fileId:string)=>Promise<{title:string;html:string}|null>
  dyofficePrepareAiDoc?:(signal?:AbortSignal,expectedProof?:string)=>Promise<PreparedAiDocumentCreator>
  dyofficeOpenPdfCopy?:(receipt:RevisionRef,proof:string,signal?:AbortSignal)=>Promise<void>
  dyofficeOpenKnowledgeSource?:(id:string,revision:string)=>Promise<void>
  dyofficeCreateAiDoc?:(request:{type?:'docx'|'pdf';title:string;content:string;file?:Blob})=>Promise<RevisionRef>
  dyofficeCreateAiXlsx?:(request:{title:string;sheetName?:string;content:string})=>Promise<void>
 }
}
let entryRecovery:ReturnType<typeof createEntryRecovery>|undefined
let entryRecoveryNotice=''
async function resolveOpenDocument(id:string,sourceRevision?:string){
 // Capture the authenticated workspace, not a mutable cookie-only client. The
 // bound reader rechecks session proof after each request, including other tabs.
 const workspace=sourceWorkspace
 if(!workspace)throw new Error('请先核对登录状态。')
 const document=await readOpenDocument(workspace,capabilities,id,sourceRevision)
 notifyFilesChanged()
 return document
}
async function open(id:string,sourceRevision?:string){
 const token=documentTabs.reserveOpen(id)
 documentTabs.open(await resolveOpenDocument(id,sourceRevision),token)
}
let busy=false
async function upload(file:File,expectedProof=sourceWorkspace?.bound.proof){if(busy)throw new Error('正在导入，请稍候');if(!/\.(docx|xlsx|pptx|pdf)$/i.test(file.name))throw new Error('请选择 DOCX、XLSX、PPTX 或 PDF 文件。');busy=true;try{if(!expectedProof)throw new Error('登录状态未核验，请重新加载当前工作区。');const result=await client.upload(file,expectedProof);try{await open(result.file.fileId)}catch{notifyFilesChanged();throw new Error('文件已上传，但打开失败。请从最近文件中打开，不要重复上传。')}}finally{busy=false}}
async function browse(){showUpload()}
const unsupported=async()=>{throw new Error('此桌面操作尚未适配到本地 Web。')}
function installBridge(){
 window.dyofficeOpenKnowledgeSource=async (id,revision)=>{
  try{await open(id,revision)}catch(error){
   if(error instanceof CitationTabUnverified){
    notice(initialLanguage==='en'?'Save any changes and close the existing source tab before opening the citation.':'请先保留更改并关闭已打开的来源标签页，再打开引用。')
    return
   }
   if(!(error instanceof CitedRevisionChanged))throw error
   notice(initialLanguage==='en'?'The cited version is no longer current. Search the knowledge base again.':'引用的版本已失效，请重新检索知识库。')
  }
 }
 window.aiOffice=createLocalHomeBridge({request:workspaceSession.request,preferences,open,openTrash:()=>showTrash(),changed:notifyFilesChanged,renamed:documentTabs.rename,unsupported:m=>notice(m),browse})
 window.aiOffice.newDoc=async()=>{const proof=sourceWorkspace?.bound.proof;if(!proof)throw new Error('登录状态未核验，请重新加载当前工作区。');if(capabilities.docx!=='editable')return unsupported();const response=await fetch(blankDocx);if(!response.ok)throw new Error('原版空白模板不可用');await upload(new File([await response.blob()],'未命名.docx'),proof)}
 window.aiOffice.newSheet=createLocalNewSheet({getSessionProof:()=>sourceWorkspace?.bound.proof,bindSession:proof=>client.bindSession(proof),fetchTemplate:()=>fetch(blankXlsx),open:(id,request)=>openCreatedDocument(documentTabs,capabilities,id,request),changed:notifyFilesChanged})
 window.aiOffice.newSlide=createLocalNewSlide({getSessionProof:()=>sourceWorkspace?.bound.proof,bindSession:proof=>client.bindSession(proof),fetchTemplate:()=>fetch(blankPptx),open:(id,request)=>openCreatedDocument(documentTabs,capabilities,id,request),changed:notifyFilesChanged})
 window.aiOffice.newPdf=createLocalNewPdf({
  getSessionProof:()=>sourceWorkspace?.bound.proof,
  bindSession:proof=>client.bindSession(proof),
  open:(id,request)=>openCreatedDocument(documentTabs,capabilities,id,request),
  changed:notifyFilesChanged,
 })
 window.dyofficeConsumeAiDocContent=async fileId=>pendingAiDocContents.consume(fileId)
 window.dyofficeCompleteAiDocContent=(fileId,result)=>pendingAiDocContents.complete(fileId,result)
 window.dyofficeOpenPdfCopy=async(receipt,proof,signal)=>{
  const bound=await client.bindSession(proof,signal)
  signal?.throwIfAborted()
  notifyFilesChanged()
  await openCreatedDocument(documentTabs,capabilities,receipt.fileId,bound.request)
 }
 window.dyofficePrepareAiDoc=async(signal,expectedProof)=>{
  const proof=expectedProof??sourceWorkspace?.bound.proof
  if(!proof)throw new Error('登录状态未核验，请重新加载当前工作区。')
  const bound=await client.bindSession(proof,signal)
  const docxEditable=(await bound.request<Record<string,string>>('/api/v1/capabilities','GET',undefined,signal)).docx==='editable'
  let used=false
  return {docxEditable,async save({type,title,content,file},saveSignal){
   saveSignal?.throwIfAborted()
   if(used)throw new Error('此创建请求已发起，请核对现有文件，不要重复创建。')
   if(!['docx','pdf'].includes(type)||typeof title!=='string'||!title.trim()||typeof content!=='string'||!content.trim())throw new Error('文档创建请求无效。')
   const stem=title.replace(/[\\/:*?"<>|]/g,' ').trim().slice(0,120)||'未命名'
   let createdFile:File
   if(type==='pdf'){
    if(!file||file.type!=='application/pdf'||file.size===0)throw new Error('PDF 文档生成失败。')
    createdFile=new File([file],`${stem}.pdf`,{type:'application/pdf'})
   }else{
    if(!docxEditable||(await bound.request<Record<string,string>>('/api/v1/capabilities','GET',undefined,saveSignal)).docx!=='editable')throw new Error('当前运行环境未启用安全的 DOCX 编辑，暂不支持新建。')
    const response=await fetch(blankDocx,{signal:saveSignal})
    if(!response.ok)throw new Error('原版空白模板不可用')
    createdFile=new File([await response.arrayBuffer()],`${stem}.docx`)
   }
   saveSignal?.throwIfAborted()
   // Reusing this closure after any write is unsafe, including a late auth error.
   used=true
   const stage=await bound.request<{uploadId:string;fileId:string}>('/api/v1/files/uploads','POST',{name:createdFile.name,size:createdFile.size},saveSignal)
   await bound.request(`/api/v1/uploads/${encodeURIComponent(stage.uploadId)}/content`,'PUT',createdFile,saveSignal)
   const result=await bound.request<{file:RevisionRef}>(`/api/v1/uploads/${encodeURIComponent(stage.uploadId)}/finish`,'POST',undefined,saveSignal)
   if(!isRevisionRef(result?.file)||result.file.size<1||result.file.fileId!==stage.fileId)throw new Error('无法确认文档创建的保存版本，请核对工作区文件，不要重复创建。')
   const id=result.file.fileId
   const saved=type==='docx'?pendingAiDocContents.begin(id,{title,html:content}):null
   notifyFilesChanged()
   try{await openCreatedDocument(documentTabs,capabilities,id,bound.request)}catch{
    const error=`${type==='pdf'?'PDF':'Word 文档'}已写入工作区，但打开失败。请从最近文件中打开，不要重复创建。`
    if(saved)pendingAiDocContents.complete(id,{ok:false,error})
    throw new Error(error)
   }
   const receipt=saved?await saved:result.file
   const confirmed=await bound.request<RevisionRef>(`/api/v1/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(receipt.revision)}`,'GET',undefined,saveSignal)
   if(!isRevisionRef(confirmed)||confirmed.fileId!==id||confirmed.revision!==receipt.revision||confirmed.sha256!==receipt.sha256||confirmed.size!==receipt.size)throw new Error('无法确认正文的保存版本，请核对工作区文件，不要重复创建。')
   return confirmed
  }}
 }
 window.dyofficeCreateAiDoc=async input=>(await window.dyofficePrepareAiDoc!()).save({...input,type:input.type??'docx'})
 window.dyofficeCreateAiXlsx=async request=>{
  const proof=sourceWorkspace?.bound.proof
  if(!proof)throw new Error('登录状态未核验，请重新加载当前工作区。')
  const bound=await client.bindSession(proof)
  if((await bound.request<Record<string,string>>('/api/v1/capabilities')).xlsx!=='editable')throw new Error('当前运行环境未启用安全的 XLSX 编辑，暂不支持新建。')
  const result=await bound.request<{file:{fileId:string}}>('/api/v1/ai/xlsx-documents','POST',request)
  const id=result?.file?.fileId
  if(!id)throw new Error('电子表格创建失败')
  notifyFilesChanged()
  try{await openCreatedDocument(documentTabs,capabilities,id,bound.request)}catch{throw new Error('电子表格已创建，但打开失败。请从最近文件中打开，不要重复创建。')}
 }
 window.aiOfficeTabs={list:async()=>documentTabs.list(),activate:async id=>documentTabs.activate(id),close:async id=>{await documentTabs.close(id)},onChanged:documentTabs.subscribe,showNewMenu:async(x,y)=>showChromeMenu('new',x,y),showAppMenu:async(x,y)=>showChromeMenu('app',x,y),showMenu:async(x,y)=>showChromeMenu('tabs',x,y),showTabMenu:async(id,x,y)=>showChromeMenu('tab',x,y,id),detach:unsupported,tearOff:async()=>false,dragTornWindow:()=>{},dockTornWindow:unsupported,endTornDrag:async()=>{},onDockPreview:()=>()=>{},reportDockIndex:()=>{},reorder:async(id,index)=>documentTabs.reorder(id,index),notifyChromePressed:()=>{},onChromePressed:()=>()=>{}} satisfies TabsApi
}
async function restore(){
 const workspace=await createSourceWorkspaceSession(client)
 const bound=workspace.bound
 const identity=await bound.request<{user:User;deploymentId?:string}>('/api/v1/auth/me')
 preferenceSession.bind(bound)
  globalSettingsSession.bind(bound)
 const personal=await preferences.getPreferences()
 const catalog=await bound.request<Record<string,string>>('/api/v1/capabilities')
 user=identity.user;capabilities=catalog;initialLanguage=personal.language==='en'?'en':'zh';userSkills=createUserSkillsClient(bound.request);sourceWorkspace=workspace;workspaceSession.bind(bound)
 if(personal.theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=personal.theme
 // Only authenticated identity may select a storage namespace. Legacy servers
 // without a deployment identity safely skip entry restoration.
 if(identity.deploymentId && !documentTabs.documents().length){
  let storage:Storage|undefined;try{storage=window.sessionStorage}catch{}
  entryRecovery=storage?createEntryRecovery(storage,identity.deploymentId,user.id):undefined
  const restoringHash=location.hash
  const restored=await resolveEntrySnapshot(entryRecovery?.read()??{ids:[],active:'home'},parseEntryHash(restoringHash),async id=>resolvedDocument(capabilities,id,await bound.request(`/api/v1/files/${encodeURIComponent(id)}`)))
  documentTabs.restoreEntries(restored.entries,restored.active)
  entryRecoveryNotice=restored.failed?'部分文档入口无法恢复，请从最近文件重新打开。未保存内容不会由入口恢复。':''
  // Let the Shell resolve a newer route instead of normalizing it back to the snapshot.
  if(location.hash===restoringHash)history.replaceState(null,'',entryHash(restored.active))
 }
 installBridge()
}
let logoutPending=false
async function logout(){
 if(logoutPending)return
 logoutPending=true
 const resumeEntries=documentTabs.suspendEntries(),app=document.getElementById('app'),wasInert=app?.inert??false
 let leaving=false
 if(app)app.inert=true
 try{
 const editors=[...document.querySelectorAll<HTMLIFrameElement>('.workspace-document-frame')].map(frame=>({id:frame.dataset.documentId!,api:frame.contentWindow as unknown as {dyofficeEditorCanClose?:()=>Promise<boolean>;dyofficeEditorDispose?:()=>Promise<boolean>}|null}))
 for(const editor of editors)if(!editor.api?.dyofficeEditorCanClose||!await editor.api.dyofficeEditorCanClose())return
 // Avoid activating a dormant neighbor while disposing for logout.
 documentTabs.activate('home')
 for(const editor of editors){
  if(!editor.api?.dyofficeEditorDispose||!await editor.api.dyofficeEditorDispose())return
  await documentTabs.close(editor.id)
 }
 await client.logout();entryRecovery?.clear();location.replace('/');leaving=true
 }finally{
  // Keep admission closed until navigation after successful session invalidation.
  if(!leaving){resumeEntries();if(app)app.inert=wasInert;logoutPending=false}
 }
}
function WorkspacePageContent({page,onClose,onCloseGuardChange,settingsTab,onSettingsTabChange,channelId,onOpenChannel}:{channelId?:string;onOpenChannel:(id:string)=>void;settingsTab?:string;onSettingsTabChange?:(tab:string)=>void;page:WorkspacePage;onClose:()=>void;onCloseGuardChange:(guard:(()=>boolean)|null)=>void}){
 const [sessionVersion,setSessionVersion]=useState(0)
 const registerGuard=onCloseGuardChange
 async function updateSession(proof:string){
  const workspace=await createSourceWorkspaceSession(client,proof)
  const bound=workspace.bound
  const identity=await bound.request<{user:User}>('/api/v1/auth/me')
  if(identity.user.id!==user?.id)throw new Error('登录状态已改变，请重新加载当前工作区。')
  preferenceSession.bind(bound)
  globalSettingsSession.bind(bound)
  userSkills=createUserSkillsClient(bound.request);sourceWorkspace=workspace;workspaceSession.bind(bound)
  setSessionVersion(version=>version+1)
 }
 const openChannelDocument=async(fileId:string,channelId:string)=>{
  const existing=documentTabs.documents().find(file=>file.id===fileId)
  if(existing){
   if(new URL(existing.src,location.origin).searchParams.get('channel')!==channelId)throw Error('请先关闭已打开的来源文档，再从频道打开。')
   documentTabs.activate(fileId);onClose();return
  }
  const token=documentTabs.reserveOpen(fileId),file=await resolveOpenDocument(fileId)
  file.src+=(file.src.includes('?')?'&':'?')+'channel='+encodeURIComponent(channelId)
  documentTabs.open(file,token);onClose()
 }
 if(page==='channels'&&sourceWorkspace)return <AssistantChannelsPage request={sourceWorkspace.bound.request} initialChannelId={channelId} onOpenDocument={openChannelDocument}/>
 if(page==='tasks'&&sourceWorkspace)return <BackgroundTasksPage request={sourceWorkspace.bound.request} onOpenDocument={openChannelDocument} onOpenChannel={onOpenChannel}/>
 if(page==='settings'&&user)return <WorkspaceSettings activeTab={settingsTab} onTabChange={onSettingsTabChange} sessionsClient={sessionsClient} historyClient={historyClient} user={user} load={preferences.getPreferences} save={preferences.updatePreferences} security={{changePassword:async(current,next)=>{const proof=await client.changePassword(current,next);await updateSession(proof).catch(()=>client.endSession('expired'))},onCurrentRevoked:()=>client.endSession('expired')}} skills={registerSkillsGuard=>userSkills&&<UserSkillsPanel key={sessionVersion} client={userSkills} onCloseGuardChange={registerSkillsGuard}/>} onLogout={()=>void logout().catch(e=>notice(e.message))} onClose={onClose} onCloseGuardChange={registerGuard}/>
 if(page==='users'&&user?.roles.includes('config_admin'))return <section className="workspace-panel"><LocalAdminPanel client={adminClient} presentation="page" currentUserId={user.id} onSessionRotated={proof=>{client.invalidateCsrf();if(proof)void updateSession(proof).catch(e=>notice(e.message))}} onOwnAuthorityChanged={()=>client.endSession('expired')} onClose={onClose} onCloseGuardChange={registerGuard}/></section>
 if(page==='global'&&user?.roles.includes('config_admin'))return <GlobalSettingsPanel client={globalSettings} onClose={onClose} presentation="page" onCloseGuardChange={registerGuard}/>
 if(page==='sources'&&sourceWorkspace)return <SourcesPanel key={sessionVersion} client={sourceWorkspace.sources} onClose={onClose} presentation="page" onCloseGuardChange={registerGuard}/>
 if(page==='results'&&sourceWorkspace)return <WorkspaceDataResults key={sessionVersion} client={sourceWorkspace.results} onClose={onClose} presentation="page"/>
 if(page==='trash'&&sourceWorkspace)return <WorkspaceTrash request={sourceWorkspace.bound.request} onChanged={notifyFilesChanged} onClose={onClose} presentation="page" onCloseGuardChange={registerGuard}/>
 return null
}
function Account({onOpen}:{onOpen:(page:WorkspacePage)=>void}){return <div className="account-entry">{user&&<AccountMenu user={user} onSettings={()=>onOpen('settings')} onChannels={()=>onOpen('channels')} onTasks={()=>onOpen('tasks')} onDataResults={user.roles.includes('personal')?()=>onOpen('results'):undefined} onTrash={()=>onOpen('trash')} onSources={()=>onOpen('sources')} onGlobalSettings={()=>onOpen('global')} onUsers={()=>onOpen('users')} onLogout={()=>void logout().catch(e=>notice(e.message))}/>}</div>}

function Shell({recovery=false}:{recovery?:boolean}){
 const [message,setMessage]=useState(entryRecoveryNotice),[page,setPage]=useState<WorkspacePage|null>(()=>new URLSearchParams(location.search).get('panel')==='channels'?'channels':null)
 const [channelId,setChannelId]=useState<string|undefined>(undefined)
 const [tabs,setTabs]=useState(documentTabs.list())
 const [uploadFiles,setUploadFiles]=useState<File[]|null>(null)
 showUpload=files=>setUploadFiles(files??[])
 const [chromeMenu,setChromeMenu]=useState<{kind:'app'|'new'|'tabs'|'tab';x:number;y:number;id?:string}|null>(null)
 showChromeMenu=(kind,x,y,id)=>setChromeMenu({kind,x,y,id})
 const routeNavigation=useRef(false)
 useEffect(()=>{
  const dragover=(event:DragEvent)=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault()}
  const drop=(event:DragEvent)=>{if(event.target instanceof Element&&event.target.closest('.workspace-upload-modal'))return;const files=[...(event.dataTransfer?.files??[])];if(!files.length)return;event.preventDefault();if(!document.querySelector('.workspace-upload-modal'))showUpload(files)}
  window.addEventListener('dragover',dragover);window.addEventListener('drop',drop,true)
  return()=>{window.removeEventListener('dragover',dragover);window.removeEventListener('drop',drop,true)}
 },[])
 const closeGuard=useRef<(()=>boolean)|null>(null)
 const registerGuard=useCallback((guard:(()=>boolean)|null)=>{closeGuard.current=guard},[])
 const [settingsTab,setSettingsTab]=useState('account')
 useEffect(()=>{if(page!=='settings')setSettingsTab('account')},[page])
 useEffect(()=>{
  const selectedHash=(id:string)=>entryHash(documentTabs.documents().some(file=>file.id===id&&file.sourceRevision)?'home':id)
  const changed=(next:ReturnType<typeof documentTabs.list>)=>{
   setTabs(next)
   const active=next.find(tab=>tab.active)?.id??'home'
   const entries=documentTabs.documents()
   const restorable=entries.filter(file=>!file.sourceRevision).map(file=>file.id)
   entryRecovery?.save(restorable,active)
   const hash=selectedHash(active)
   if(location.hash!==hash)history[routeNavigation.current?'replaceState':'pushState'](null,'',hash)
  }
  const navigation=createEntryNavigator({tabs:documentTabs,resolve:resolveOpenDocument,
   allow:()=>!recoveryBlocked.current&&closeGuard.current?.()!==false,
   onStart:()=>setPage(null),onError:error=>setMessage((error as Error).message),
   replace:id=>history.replaceState(null,'',selectedHash(id)),markRouting:value=>{routeNavigation.current=value}})
  let pendingInitialTarget:string|undefined
  const navigate=()=>{
   const target=parseEntryHash(location.hash)??'home'
   if(target===pendingInitialTarget)return
   pendingInitialTarget=undefined
   void navigation.navigate(target)
  }
  window.addEventListener('hashchange',navigate)
  const unsubscribe=documentTabs.subscribe(changed)
  const currentTabs=documentTabs.list()
  const target=parseEntryHash(location.hash)
  // An explicit route can arrive after restore() and before this effect installs.
  // Resolve it rather than writing the previous selection over it.
  if(target&&location.hash===entryHash(target)&&target!==currentTabs.find(tab=>tab.active)?.id){
   pendingInitialTarget=target
   void navigation.navigate(target).finally(()=>{pendingInitialTarget=undefined})
  }
  else changed(currentTabs)
  return()=>{unsubscribe();navigation.dispose();window.removeEventListener('hashchange',navigate)}
 },[])
 const activePage=useRef(page),recoveryBlocked=useRef(recovery)
 activePage.current=page;recoveryBlocked.current=recovery
 useEffect(()=>client.onSessionEnded(()=>{recoveryBlocked.current=true}),[])
 useEffect(()=>{
  const host=window as Window & {dyofficeOpenEditorSettings?:(target:'skills'|'models',source:Window)=>void}
  const openSettings=(target:'skills'|'models',source:Window)=>{
   if(recoveryBlocked.current)return
   if(!['skills','models'].includes(target)||![...document.querySelectorAll<HTMLIFrameElement>('.workspace-document-frame')].some(frame=>frame.contentWindow===source))return
   try{if(source.location.origin!==window.location.origin)return}catch{return}
   if(target==='models'&&!user?.roles.includes('config_admin')){notice('模型配置仅配置管理员可管理。');return}
   const next=target==='skills'?'settings':'global'
   if(activePage.current&&activePage.current!==next){if(closeGuard.current?.()===false){notice('请先完成或保存当前配置操作，再切换设置。');return}closeGuard.current=null}
   if(target==='skills')setSettingsTab('skills')
   activePage.current=next;setPage(next)
  }
  host.dyofficeOpenEditorSettings=openSettings
  return()=>{if(host.dyofficeOpenEditorSettings===openSettings)delete host.dyofficeOpenEditorSettings}
 },[])
 const close=()=>{if(closeGuard.current?.()===false)return;setPage(null)}
 notice=setMessage;showTrash=()=>setPage('trash')
 return <>
  <AppFrame hideAppMenu hideSingleTabList initialOnboardingSeen={true} homeProps={{renderHero:({language,...fallback})=><HomeHero key={sourceWorkspace?.bound.proof} fallback={fallback} language={language} request={sourceWorkspace?.bound.request??client.request} csrfToken={sourceWorkspace?.bound.proof??''} enabled={!recovery}/>,capabilities:{localFolders:false,copyPath:false,duplicateFile:false,starredGroups:false,cloudProjects:false,semanticRanking:false,serverFileSort:true},supportedFormats:['docx','xlsx','pptx','pdf'],supportedNewFormats:localNewFormats(capabilities),accountEntry:<Account onOpen={setPage}/>,folderDeleteDescription:name=>`仅可删除空文件夹「${name}」。请先移出文件和子文件夹；回收站中仍属于此目录的文件需先恢复并移出。`}} editorContent={<>{documentTabs.renderedDocuments().map(file=><div key={file.id} data-file-id={file.id} className="workspace-document" hidden={!tabs.find(tab=>tab.id===file.id)?.active}>{file.format==='pdf'||file.src.startsWith('/native-')?<DocumentFrame key={file.src} file={file} registerGuard={documentTabs.setGuard} onAutoPdfName={updateAutoPdfTab} sessionActive={()=>!recoveryBlocked.current}/>:<DocumentPreview key={file.src} fileId={file.id} name={file.name} format={file.format} sourceRevision={file.sourceRevision} request={sourceWorkspace?.bound.request??client.request}/>}</div>)}</>}/>
  {page&&<NativeSettingsDialog title={workspacePages[page]} onClose={close}><WorkspacePageContent key={page} page={page} channelId={channelId} onOpenChannel={id=>{setChannelId(id);setPage('channels')}} settingsTab={settingsTab} onSettingsTabChange={setSettingsTab} onClose={()=>setPage(null)} onCloseGuardChange={registerGuard}/></NativeSettingsDialog>}
  {uploadFiles!==null&&<WorkspaceUploadDialog open initialFiles={uploadFiles} upload={upload} onClose={()=>setUploadFiles(null)}/>}
  {chromeMenu&&<Dropdown open trigger={['click']} onOpenChange={open=>{if(!open)setChromeMenu(null)}} menu={{items:chromeMenu.kind==='tabs'?tabs.map(tab=>({key:tab.id,label:tab.title})):chromeMenu.kind==='tab'?[{key:'close',label:'关闭文档',danger:true}]:chromeMenu.kind==='new'?[...(capabilities.docx==='editable'?[{key:'word',label:'新建 Word 文档'}]:[]),...(capabilities.xlsx==='editable'?[{key:'sheet',label:'新建 Excel 表格'}]:[]),...(capabilities.pptx==='editable'?[{key:'slide',label:'新建 PPT 演示文稿'}]:[]),...(capabilities.pdfEditor==='editable'?[{key:'pdf',label:'新建 PDF'}]:[]),{key:'import',label:'打开文件…'}]:[{key:'home',label:'首页'},{key:'import',label:'打开文件…'},{key:'settings',label:'个人设置'}],onClick:({key})=>{const target=chromeMenu;setChromeMenu(null);if(target.kind==='tabs')documentTabs.activate(key);else if(key==='close'&&target.id)void documentTabs.close(target.id).catch(e=>notice(e.message));else if(key==='word')void window.aiOffice.newDoc().catch(e=>notice(e.message));else if(key==='sheet')void window.aiOffice.newSheet().catch(e=>notice(e.message));else if(key==='slide')void window.aiOffice.newSlide().catch(e=>notice(e.message));else if(key==='pdf')void window.aiOffice.newPdf().catch(e=>notice(e.message));else if(key==='import')void browse().catch(e=>notice(e.message));else if(key==='home')documentTabs.activate('home');else if(key==='settings')setPage('settings')}}}><span style={{position:'fixed',left:Math.min(chromeMenu.x,window.innerWidth-200),top:chromeMenu.y,width:1,height:1}}/></Dropdown>}
  {message&&<div className="web-notice" role="alert">{message}<button onClick={()=>setMessage('')}>关闭</button></div>}
 </>
}

function Login({done}:{done:()=>void}){
 const [error,setError]=useState(''),[pending,setPending]=useState(false),[signed,setSigned]=useState(false),[action,setAction]=useState(false)
 if(action&&!signed)return <main className="dy-login dy-login-signin dy-login-password-action"><Card className="dy-login-card"><img className="dy-login-logo" src={logo} alt="DyOffice"/><PasswordActionForm onClose={()=>{setAction(false);client.invalidateCsrf()}}/></Card></main>
 return <main className="dy-login dy-login-signin"><Card className="dy-login-card">
 <header className="dy-login-heading">
  <img className="dy-login-logo" src={logo} alt="DyOffice"/>
  <h1>登录你的工作区</h1>
  <p>统一管理文档、数据与个人工作。</p>
 </header>
 <div className="dy-login-fields">
 {error&&<Alert type="error" showIcon title={error} className="dy-login-error"/>}
 <Form layout="vertical" onFinish={async(values:{username:string;password:string})=>{if(pending)return;setPending(true);setError('');try{if(!signed){await client.login(values.username,values.password);setSigned(true)}await restore();done()}catch(err){const status=(err as {status?:number}).status;setError(status===401?'用户名或密码不正确，请核对后重试。':status===403?'登录请求被拒绝，请从工作区入口打开页面后重试。':status===429?'登录尝试过于频繁，请稍后再试。':(err as Error).message)}finally{setPending(false)}}}>
 {!signed&&<><Form.Item label="用户名" name="username" rules={[{required:true,message:'请输入用户名'}]}><Input aria-label="用户名" autoComplete="username" placeholder="请输入用户名" disabled={pending}/></Form.Item><Form.Item label="密码" name="password" rules={[{required:true,message:'请输入密码'}]}><Input.Password aria-label="密码" autoComplete="current-password" placeholder="请输入密码" disabled={pending}/></Form.Item></>}
 <Button type="primary" htmlType="submit" block loading={pending} aria-label={signed?'重新加载工作区':'登录'} aria-busy={pending}>{signed?'重新加载工作区':'登录'}</Button>
 </Form>
 <div className="dy-login-support">
  <Button className="dy-login-reset" type="link" onClick={()=>setAction(true)} disabled={pending || signed}>设置密码</Button>
  <Typography.Paragraph type="secondary" className="dy-login-footer">你的文档与数据，仅在授权范围内访问。</Typography.Paragraph>
 </div>
 </div>
 </Card></main>
}

function Root(){
 const [state,setState]=useState<'loading'|'login'|'ready'|'error'>('loading'),[error,setError]=useState(''),[recovery,setRecovery]=useState<SessionEndReason|null>(null)
 useEffect(()=>client.onSessionEnded(reason=>{if(user)setRecovery(current=>current??reason)}),[])
 useEffect(()=>{if(recovery)return hideAccountRecoveryPortals()},[recovery])
 useEffect(()=>{void restore().then(()=>setState('ready')).catch(e=>{if(e.status===401)setState('login');else{setError(e.message);setState('error')}})},[])
 if(state==='loading')return <WorkspaceLoading/>
 if(state==='error')return <main className="web-login" role="alert"><p>{error}</p><button onClick={()=>location.reload()}>重试</button><button onClick={()=>void logout().catch(e=>setError(e.message))}>退出登录</button></main>
 return state==='ready'?<LocaleProvider initial={initialLanguage} onError={error=>notice(error instanceof Error?error.message:String(error))}>
  <div inert={recovery?true:undefined} style={{display:recovery?'none':'contents'}}><Shell recovery={!!recovery}/></div>
  {recovery&&<main className="dy-login account-session-recovery" role="alertdialog" aria-modal="true" aria-label="登录状态需要核对" onKeyDown={event=>{if(event.key==='Tab'){event.preventDefault();event.currentTarget.querySelector<HTMLButtonElement>('button')?.focus()}}} style={{position:'fixed',inset:0,zIndex:2000}}><Card className="dy-login-card"><Typography.Title level={4}>{recovery==='expired'?'会话已过期':'退出结果尚未确认'}</Typography.Title><Typography.Paragraph type="secondary">{recovery==='expired'?'请重新加载并核对登录状态，再继续使用工作区。':'退出请求未能确认，请重新加载并核对当前登录状态，不要重复提交。'}已打开的文档仍保留在当前页面；重新加载前请确认未保存的更改。</Typography.Paragraph><Button autoFocus type="primary" block onClick={()=>location.reload()}>重新加载并核对登录状态</Button></Card></main>}
 </LocaleProvider>:<Login done={()=>setState('ready')}/>
}

installScreenTips()
window.addEventListener('unhandledrejection',event=>{notice(event.reason instanceof Error?event.reason.message:String(event.reason));event.preventDefault()})
function WebTheme({children}:{children:React.ReactNode}){
 const [dark,setDark]=useState(false)
 useEffect(()=>{
  const media=matchMedia('(prefers-color-scheme: dark)')
  const update=()=>setDark(document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&media.matches))
  const observer=new MutationObserver(update);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});media.addEventListener('change',update);update()
  return()=>{observer.disconnect();media.removeEventListener('change',update)}
 },[])
 return <ConfigProvider locale={zhCN} button={{autoInsertSpace:false}} theme={{algorithm:dark?antdTheme.darkAlgorithm:antdTheme.defaultAlgorithm,token:{colorPrimary:'#2563eb',borderRadius:8,fontFamily:'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'},components:{Button:{controlHeight:36},Input:{controlHeight:38},Select:{controlHeight:38}}}}>{children}</ConfigProvider>
}
createRoot(document.getElementById('app')!).render(<WebTheme><Root/></WebTheme>)
