import React,{useEffect,useState,useCallback,useRef} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkspaceSettings} from './WorkspaceSettings'
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
import {createGlobalSettingsClient} from './global-settings-client'
import {GlobalSettingsPanel} from './GlobalSettingsPanel'
import {WorkspaceTrash} from './WorkspaceTrash'
import {createUserSkillsClient} from './user-skills-client'
import {UserSkillsPanel} from './UserSkillsPanel'
import {SourcesPanel} from './SourcesPanel'
import {createSourceWorkspaceSession} from './source-workspace-session'
import blankDocx from '../../../shell/build/shell-new/blank.docx?url'
import blankXlsx from '../../../shell/build/shell-new/blank.xlsx?url'
import {createLocalNewSheet,localNewFormats,openCreatedDocument} from './local-new-sheet'

import {hideAccountRecoveryPortals} from './account-recovery-portals'
import {createLocalShellClient,type SessionEndReason} from './local-client'
import {createLocalAdminClient} from './local-admin-client'
import {createLocalSessionsClient} from './local-sessions-client'
import {createLoginHistoryClient} from './local-login-history-client'
import {ConfigProvider,theme as antdTheme,Dropdown,Modal,Button,Alert,Form,Input,Card,Typography} from 'antd'
import logo from '../../../shell/src/renderer/src/assets/dyoffice-logo.svg'
import zhCN from 'antd/locale/zh_CN'
const workspacePages={settings:'个人设置',trash:'回收站',sources:'数据连接',global:'全局配置',users:'用户管理'} as const
type WorkspacePage=keyof typeof workspacePages
import {HomeAssistant} from './HomeAssistant'
import {AccountMenu} from './AccountMenu'
import {createDocumentTabs,type DocumentFormat} from './document-tabs'
import {resolvedDocument,readOpenDocument} from './document-entry-reader'
import {createEntryNavigator} from './workspace-entry-navigation'
import {createEntryRecovery,entryHash,parseEntryHash,resolveEntrySnapshot} from './workspace-entry-recovery'
import {DocumentFrame} from './DocumentFrame'
import {DocumentPreview} from './DocumentPreview'
import './workspace-shell.css'
import './home-entry-b.css'
import {LocalAdminPanel} from './LocalAdminPanel'
import {PasswordActionForm} from './PasswordActionForm'
import './config-polish.css'
const client=createLocalShellClient()
const adminClient=createLocalAdminClient(fetch,()=>client.endSession('expired'))
const sessionsClient=createLocalSessionsClient(fetch,()=>client.endSession('expired'))
const historyClient=createLoginHistoryClient(fetch,()=>client.endSession('expired'))
const preferenceSession=createLocalPreferencesSession(client)
const preferences=preferenceSession.preferences
const globalSettings=createGlobalSettingsClient(client.request)
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
const documentTabs=createDocumentTabs()
let entryRecovery:ReturnType<typeof createEntryRecovery>|undefined
let entryRecoveryNotice=''
async function resolveOpenDocument(id:string){
 // Capture the authenticated workspace, not a mutable cookie-only client. The
 // bound reader rechecks session proof after each request, including other tabs.
 const workspace=sourceWorkspace
 if(!workspace)throw new Error('请先核对登录状态。')
 const document=await readOpenDocument(workspace,capabilities,id)
 notifyFilesChanged()
 return document
}
async function open(id:string){
 const token=documentTabs.reserveOpen(id)
 documentTabs.open(await resolveOpenDocument(id),token)
}
let busy=false
async function upload(file:File,expectedProof=sourceWorkspace?.bound.proof){if(busy)throw new Error('正在导入，请稍候');if(!/\.(docx|xlsx|pptx|pdf)$/i.test(file.name))throw new Error('请选择 DOCX、XLSX、PPTX 或 PDF 文件。');busy=true;try{if(!expectedProof)throw new Error('登录状态未核验，请重新加载当前工作区。');const result=await client.upload(file,expectedProof);try{await open(result.file.fileId)}catch{notifyFilesChanged();throw new Error('文件已上传，但打开失败。请从最近文件中打开，不要重复上传。')}}finally{busy=false}}
async function browse(){showUpload()}
const unsupported=async()=>{throw new Error('此桌面操作尚未适配到本地 Web。')}
function installBridge(){
 window.aiOffice=createLocalHomeBridge({request:client.request,preferences,open,openTrash:()=>showTrash(),changed:notifyFilesChanged,renamed:documentTabs.rename,unsupported:m=>notice(m),browse})
 window.aiOffice.newDoc=async()=>{const proof=sourceWorkspace?.bound.proof;if(!proof)throw new Error('登录状态未核验，请重新加载当前工作区。');if(capabilities.docx!=='editable')return unsupported();const response=await fetch(blankDocx);if(!response.ok)throw new Error('原版空白模板不可用');await upload(new File([await response.blob()],'未命名.docx'),proof)}
 window.aiOffice.newSheet=createLocalNewSheet({getSessionProof:()=>sourceWorkspace?.bound.proof,bindSession:proof=>client.bindSession(proof),fetchTemplate:()=>fetch(blankXlsx),open:(id,request)=>openCreatedDocument(documentTabs,capabilities,id,request),changed:notifyFilesChanged})
 window.aiOfficeTabs={list:async()=>documentTabs.list(),activate:async id=>documentTabs.activate(id),close:async id=>{await documentTabs.close(id)},onChanged:documentTabs.subscribe,showNewMenu:async(x,y)=>showChromeMenu('new',x,y),showAppMenu:async(x,y)=>showChromeMenu('app',x,y),showMenu:async(x,y)=>showChromeMenu('tabs',x,y),showTabMenu:async(id,x,y)=>showChromeMenu('tab',x,y,id),detach:unsupported,tearOff:async()=>false,dragTornWindow:()=>{},dockTornWindow:unsupported,endTornDrag:async()=>{},onDockPreview:()=>()=>{},reportDockIndex:()=>{},reorder:async(id,index)=>documentTabs.reorder(id,index),notifyChromePressed:()=>{},onChromePressed:()=>()=>{}} satisfies TabsApi
}
async function restore(){
 const workspace=await createSourceWorkspaceSession(client)
 const bound=workspace.bound
 const identity=await bound.request<{user:User;deploymentId?:string}>('/api/v1/auth/me')
 preferenceSession.bind(bound)
 const personal=await preferences.getPreferences()
 const catalog=await bound.request<Record<string,string>>('/api/v1/capabilities')
 user=identity.user;capabilities=catalog;initialLanguage=personal.language==='en'?'en':'zh';userSkills=createUserSkillsClient(bound.request);sourceWorkspace=workspace
 if(personal.theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=personal.theme
 // Only authenticated identity may select a storage namespace. Legacy servers
 // without a deployment identity safely skip entry restoration.
 if(identity.deploymentId && !documentTabs.documents().length){
  let storage:Storage|undefined;try{storage=window.sessionStorage}catch{}
  entryRecovery=storage?createEntryRecovery(storage,identity.deploymentId,user.id):undefined
  const restored=await resolveEntrySnapshot(entryRecovery?.read()??{ids:[],active:'home'},parseEntryHash(location.hash),async id=>resolvedDocument(capabilities,id,await bound.request(`/api/v1/files/${encodeURIComponent(id)}`)))
  documentTabs.restoreEntries(restored.entries,restored.active)
  entryRecoveryNotice=restored.failed?'部分文档入口无法恢复，请从最近文件重新打开。未保存内容不会由入口恢复。':''
  history.replaceState(null,'',entryHash(restored.active))
 }
 installBridge()
}
async function logout(){
 const editors=[...document.querySelectorAll<HTMLIFrameElement>('.workspace-document-frame')].map(frame=>({id:frame.dataset.documentId!,api:frame.contentWindow as unknown as {dyofficeEditorCanClose?:()=>Promise<boolean>;dyofficeEditorDispose?:()=>Promise<boolean>}|null}))
 for(const editor of editors)if(!editor.api?.dyofficeEditorCanClose||!await editor.api.dyofficeEditorCanClose())return
 // Avoid activating a dormant neighbor while disposing for logout.
 documentTabs.activate('home')
 for(const editor of editors){
  if(!editor.api?.dyofficeEditorDispose||!await editor.api.dyofficeEditorDispose())return
  await documentTabs.close(editor.id)
 }
 await client.logout();entryRecovery?.clear();location.replace('/')
}
function WorkspacePageContent({page,onClose,onCloseGuardChange,settingsTab,onSettingsTabChange}:{settingsTab?:string;onSettingsTabChange?:(tab:string)=>void;page:WorkspacePage;onClose:()=>void;onCloseGuardChange:(guard:(()=>boolean)|null)=>void}){
 const [sessionVersion,setSessionVersion]=useState(0)
 const registerGuard=onCloseGuardChange
 async function updateSession(proof:string){
  const workspace=await createSourceWorkspaceSession(client,proof)
  const bound=workspace.bound
  const identity=await bound.request<{user:User}>('/api/v1/auth/me')
  if(identity.user.id!==user?.id)throw new Error('登录状态已改变，请重新加载当前工作区。')
  preferenceSession.bind(bound)
  userSkills=createUserSkillsClient(bound.request);sourceWorkspace=workspace
  setSessionVersion(version=>version+1)
 }
 if(page==='settings'&&user)return <WorkspaceSettings activeTab={settingsTab} onTabChange={onSettingsTabChange} sessionsClient={sessionsClient} historyClient={historyClient} user={user} load={preferences.getPreferences} save={preferences.updatePreferences} security={{changePassword:async(current,next)=>{const proof=await client.changePassword(current,next);await updateSession(proof).catch(()=>client.endSession('expired'))},onCurrentRevoked:()=>client.endSession('expired')}} skills={registerSkillsGuard=>userSkills&&<UserSkillsPanel key={sessionVersion} client={userSkills} onCloseGuardChange={registerSkillsGuard}/>} onLogout={()=>void logout().catch(e=>notice(e.message))} onClose={onClose} onCloseGuardChange={registerGuard}/>
 if(page==='users'&&user?.roles.includes('config_admin'))return <section className="workspace-panel"><LocalAdminPanel client={adminClient} presentation="page" currentUserId={user.id} onSessionRotated={proof=>{client.invalidateCsrf();if(proof)void updateSession(proof).catch(e=>notice(e.message))}} onOwnAuthorityChanged={()=>client.endSession('expired')} onClose={onClose} onCloseGuardChange={registerGuard}/></section>
 if(page==='global'&&user?.roles.includes('config_admin'))return <GlobalSettingsPanel client={globalSettings} onClose={onClose} presentation="page" onCloseGuardChange={registerGuard}/>
 if(page==='sources'&&sourceWorkspace)return <SourcesPanel key={sessionVersion} client={sourceWorkspace.sources} resultsClient={sourceWorkspace.results} onClose={onClose} presentation="page" onCloseGuardChange={registerGuard}/>
 if(page==='trash'&&sourceWorkspace)return <WorkspaceTrash request={sourceWorkspace.bound.request} onChanged={notifyFilesChanged} onClose={onClose} presentation="page" onCloseGuardChange={registerGuard}/>
 return null
}
async function bindHomeAssistant(){if(!sourceWorkspace)throw new Error('登录状态未就绪。');return client.bindSession(sourceWorkspace.bound.proof)}
function Account({onOpen,recovery}:{onOpen:(page:WorkspacePage)=>void;recovery:boolean}){return <div className="account-entry">{user&&<HomeAssistant key={user.id} bind={bindHomeAssistant} recovery={recovery}/>} {user&&<AccountMenu user={user} onSettings={()=>onOpen('settings')} onTrash={()=>onOpen('trash')} onSources={()=>onOpen('sources')} onGlobalSettings={()=>onOpen('global')} onUsers={()=>onOpen('users')} onLogout={()=>void logout().catch(e=>notice(e.message))}/>}</div>}

function Shell({recovery=false}:{recovery?:boolean}){
 const [message,setMessage]=useState(entryRecoveryNotice),[page,setPage]=useState<WorkspacePage|null>(null)
 const [tabs,setTabs]=useState(documentTabs.list())
 const [uploadFiles,setUploadFiles]=useState<File[]|null>(null)
 showUpload=files=>setUploadFiles(files??[])
 const [chromeMenu,setChromeMenu]=useState<{kind:'app'|'new'|'tabs'|'tab';x:number;y:number;id?:string}|null>(null)
 showChromeMenu=(kind,x,y,id)=>setChromeMenu({kind,x,y,id})
 const routeNavigation=useRef(false)
 useEffect(()=>{
  const changed=(next:ReturnType<typeof documentTabs.list>)=>{
   setTabs(next)
   const active=next.find(tab=>tab.active)?.id??'home'
   entryRecovery?.save(next.filter(tab=>tab.id!=='home').map(tab=>tab.id),active)
   const hash=entryHash(active)
   if(location.hash!==hash)history[routeNavigation.current?'replaceState':'pushState'](null,'',hash)
  }
  changed(documentTabs.list())
  return documentTabs.subscribe(changed)
 },[])
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
  const navigation=createEntryNavigator({tabs:documentTabs,resolve:resolveOpenDocument,
   allow:()=>!recoveryBlocked.current&&closeGuard.current?.()!==false,
   onStart:()=>setPage(null),onError:error=>setMessage((error as Error).message),
   replace:id=>history.replaceState(null,'',entryHash(id)),markRouting:value=>{routeNavigation.current=value}})
  const navigate=()=>{void navigation.navigate(parseEntryHash(location.hash)??'home')}
  window.addEventListener('hashchange',navigate)
  return()=>{navigation.dispose();window.removeEventListener('hashchange',navigate)}
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
  <AppFrame hideAppMenu hideSingleTabList initialOnboardingSeen={true} homeProps={{capabilities:{localFolders:false,copyPath:false,duplicateFile:false,starredGroups:false,cloudProjects:false,semanticRanking:false,serverFileSort:true},supportedFormats:['docx','xlsx','pptx','pdf'],supportedNewFormats:localNewFormats(capabilities),accountEntry:<Account onOpen={setPage} recovery={recovery}/>,folderDeleteDescription:name=>`仅可删除空文件夹「${name}」。请先移出文件和子文件夹；回收站中仍属于此目录的文件需先恢复并移出。`}} editorContent={<>{documentTabs.renderedDocuments().map(file=><div key={file.id} className="workspace-document" hidden={!tabs.find(tab=>tab.id===file.id)?.active}>{file.src.startsWith('/native-')?<DocumentFrame file={file} registerGuard={documentTabs.setGuard}/>:<DocumentPreview fileId={file.id} name={file.name} format={file.format} request={client.request}/>}</div>)}</>}/>
  <Modal open={page!==null} title={page?workspacePages[page]:undefined} onCancel={close} footer={null} width={1120} centered destroyOnHidden maskClosable={false} className="workspace-config-modal">
   {page&&<WorkspacePageContent key={page} page={page} settingsTab={settingsTab} onSettingsTabChange={setSettingsTab} onClose={()=>setPage(null)} onCloseGuardChange={registerGuard}/>}
  </Modal>
  {uploadFiles!==null&&<WorkspaceUploadDialog open initialFiles={uploadFiles} upload={upload} onClose={()=>setUploadFiles(null)}/>}
  {chromeMenu&&<Dropdown open trigger={['click']} onOpenChange={open=>{if(!open)setChromeMenu(null)}} menu={{items:chromeMenu.kind==='tabs'?tabs.map(tab=>({key:tab.id,label:tab.title})):chromeMenu.kind==='tab'?[{key:'close',label:'关闭文档',danger:true}]:chromeMenu.kind==='new'?[...(capabilities.docx==='editable'?[{key:'word',label:'新建 Word 文档'}]:[]),...(capabilities.xlsx==='editable'?[{key:'sheet',label:'新建 Excel 表格'}]:[]),{key:'import',label:'打开文件…'}]:[{key:'home',label:'首页'},{key:'import',label:'打开文件…'},{key:'settings',label:'个人设置'}],onClick:({key})=>{const target=chromeMenu;setChromeMenu(null);if(target.kind==='tabs')documentTabs.activate(key);else if(key==='close'&&target.id)void documentTabs.close(target.id).catch(e=>notice(e.message));else if(key==='word')void window.aiOffice.newDoc().catch(e=>notice(e.message));else if(key==='sheet')void window.aiOffice.newSheet().catch(e=>notice(e.message));else if(key==='import')void browse().catch(e=>notice(e.message));else if(key==='home')documentTabs.activate('home');else if(key==='settings')setPage('settings')}}}><span style={{position:'fixed',left:Math.min(chromeMenu.x,window.innerWidth-200),top:chromeMenu.y,width:1,height:1}}/></Dropdown>}
  {message&&<div className="web-notice" role="alert">{message}<button onClick={()=>setMessage('')}>关闭</button></div>}
 </>
}

function Login({done}:{done:()=>void}){
 const [error,setError]=useState(''),[pending,setPending]=useState(false),[signed,setSigned]=useState(false),[action,setAction]=useState(false)
 if(action&&!signed)return <main className="dy-login"><Card className="dy-login-card"><img className="dy-login-logo" src={logo} alt="DyOffice"/><PasswordActionForm onClose={()=>{setAction(false);client.invalidateCsrf()}}/></Card></main>
 return <main className="dy-login"><Card className="dy-login-card"><img className="dy-login-logo" src={logo} alt="DyOffice"/><Typography.Title level={3}>登录你的工作区</Typography.Title><Typography.Paragraph type="secondary">统一管理文档、数据与个人工作。</Typography.Paragraph>
 {error&&<Alert type="error" showIcon title={error} style={{marginBottom:20}}/>}
 <Form layout="vertical" onFinish={async(values:{username:string;password:string})=>{if(pending)return;setPending(true);setError('');try{if(!signed){await client.login(values.username,values.password);setSigned(true)}await restore();done()}catch(err){const status=(err as {status?:number}).status;setError(status===401?'用户名或密码不正确，请核对后重试。':status===403?'登录请求被拒绝，请确认使用 http://localhost:3080 并刷新重试。':status===429?'登录尝试过于频繁，请稍后再试。':(err as Error).message)}finally{setPending(false)}}}>
 {!signed&&<><Form.Item label="用户名" name="username" rules={[{required:true,message:'请输入用户名'}]}><Input aria-label="用户名" autoComplete="username" placeholder="请输入用户名" disabled={pending}/></Form.Item><Form.Item label="密码" name="password" rules={[{required:true,message:'请输入密码'}]}><Input.Password aria-label="密码" autoComplete="current-password" placeholder="请输入密码" disabled={pending}/></Form.Item></>}
 <Button type="primary" htmlType="submit" block loading={pending} aria-label={signed?'重新加载工作区':'登录'} aria-busy={pending}>{signed?'重新加载工作区':'登录'}</Button>
 </Form>
 <Button type="link" block onClick={()=>setAction(true)} disabled={pending}>激活或重置密码</Button>
 <Typography.Paragraph type="secondary" className="dy-login-footer">你的文档与数据，仅在授权范围内访问。</Typography.Paragraph>
 </Card></main>
}

function Root(){
 const [state,setState]=useState<'loading'|'login'|'ready'|'error'>('loading'),[error,setError]=useState(''),[recovery,setRecovery]=useState<SessionEndReason|null>(null)
 useEffect(()=>client.onSessionEnded(reason=>{if(user)setRecovery(current=>current??reason)}),[])
 useEffect(()=>{if(recovery)return hideAccountRecoveryPortals()},[recovery])
 useEffect(()=>{void restore().then(()=>setState('ready')).catch(e=>{if(e.status===401)setState('login');else{setError(e.message);setState('error')}})},[])
 if(state==='loading')return <main className="web-login">正在加载个人工作区…</main>
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
