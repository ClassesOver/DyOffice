import React,{useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {SettingsModal,type WebSettingsAdapter} from '../../../shell/src/renderer/src/SettingsModal'
import {AppFrame} from '../../../shell/src/renderer/src/AppFrame'
import {LocaleProvider} from '../../../shell/src/renderer/src/locale'
import type {TabSummary,TabsApi} from '../../../shell/src/shared/tabs-api'
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
import {createPreferencesClient} from '../../../../packages/browser-host/src/preferences'
import {createGlobalSettingsClient} from './global-settings-client'
import {GlobalSettingsPanel} from './GlobalSettingsPanel'
import {WorkspaceTrash} from './WorkspaceTrash'
import {SourcesPanel} from './SourcesPanel'
import {WorkspaceDataResults} from './WorkspaceDataResults'
import {createSourceResultsClient} from './source-results-client'
import {createSourcesClient} from './sources-client'
import blankDocx from '../../../shell/build/shell-new/blank.docx?url'

import {createLocalShellClient} from './local-client'
import {LocalPasswordForm} from './LocalPasswordForm'
import {LocalSessionsPanel} from './LocalSessionsPanel'
import {LoginHistoryPanel} from './LoginHistoryPanel'
import {LocalAdminPanel} from './LocalAdminPanel'
import {PasswordActionForm} from './PasswordActionForm'
const client=createLocalShellClient()
const preferences=createPreferencesClient(client.request)
const globalSettings=createGlobalSettingsClient(client.request)
const sourcesClient=createSourcesClient(client.request)
const sourceResultsClient=createSourceResultsClient(client.request)
type User={id:string;username:string;displayName:string;roles:string[]}
let user:User|null=null
let initialLanguage:'zh'|'en'='zh'
let notice=(message:string)=>window.alert(message)
let showTrash=()=>{}
let capabilities:Record<string,string>={}
const tabs:TabSummary[]=[{id:'home',kind:'home',title:'首页',active:true,closable:false}]
async function open(id:string){
 const result=await client.request<{name:string;format:string;file:{fileId:string;revision:string};downloadEndpoint:string}>(`/api/v1/files/${encodeURIComponent(id)}`)
 if(result.file.fileId!==id)throw new Error('文件标识不匹配。')
 await client.request(`/api/v1/workspace/files/${encodeURIComponent(id)}/open`,'POST')
 notifyFilesChanged()
 if(!['docx','xlsx'].includes(result.format)||capabilities[result.format]!=='editable'){
  if(!['docx','xlsx','pptx','pdf'].includes(result.format)||typeof result.file.revision!=='string'||!result.file.revision||result.downloadEndpoint!==`/api/v1/files/${encodeURIComponent(id)}/content?revision=${encodeURIComponent(result.file.revision)}`)throw new Error('下载地址无效。')
  const link=document.createElement('a');link.href=result.downloadEndpoint;link.download=result.name;link.click();return
 }
 // Native editor forbids framing. Use its guarded top-level lifecycle, not a legacy iframe.
 location.assign(`/native-${result.format}/?fileId=${encodeURIComponent(result.file.fileId)}`)
}
let busy=false
async function upload(file:File){if(busy)throw new Error('正在导入，请稍候');if(!/\.(docx|xlsx|pptx|pdf)$/i.test(file.name))throw new Error('请选择 DOCX、XLSX、PPTX 或 PDF 文件。');busy=true;try{const result=await client.upload(file);if(['docx','xlsx'].includes(result.format)&&capabilities[result.format]==='editable')await open(result.file.fileId);else{await client.request(`/api/v1/workspace/files/${encodeURIComponent(result.file.fileId)}/open`,'POST');notifyFilesChanged();notice('文件已导入，点击文件可下载原件。')}}finally{busy=false}}
async function browse(){const input=document.createElement('input');input.type='file';input.accept='.docx,.xlsx,.pptx,.pdf';input.onchange=()=>{const file=input.files?.[0];if(file)void upload(file).catch(e=>notice(e.message))};input.click()}
const unsupported=async()=>{throw new Error('此桌面操作尚未适配到本地 Web。')}
function installBridge(){
 window.aiOffice=createLocalHomeBridge({request:client.request,preferences,open,openTrash:()=>showTrash(),changed:notifyFilesChanged,unsupported:m=>notice(m),browse})
 window.aiOffice.newDoc=async()=>{if(capabilities.docx!=='editable')return unsupported();const response=await fetch(blankDocx);if(!response.ok)throw new Error('原版空白模板不可用');await upload(new File([await response.blob()],'未命名.docx'))}
 window.aiOfficeTabs={list:async()=>tabs.map(t=>({...t})),activate:async id=>{if(id!=='home')await unsupported()},close:unsupported,onChanged:()=>()=>{},showNewMenu:browse,showAppMenu:async()=>notice('本地账号工作区；DOCX 编辑器在独立页面打开，可通过浏览器返回首页。'),showMenu:unsupported,showTabMenu:unsupported,detach:unsupported,tearOff:async()=>false,dragTornWindow:()=>{},dockTornWindow:unsupported,endTornDrag:async()=>{},onDockPreview:()=>()=>{},reportDockIndex:()=>{},reorder:unsupported,notifyChromePressed:()=>{},onChromePressed:()=>()=>{}} satisfies TabsApi
}
async function restore(){
 const identity=await client.request<{user:User}>('/api/v1/auth/me')
 const personal=await preferences.getPreferences()
 const catalog=await client.request<Record<string,string>>('/api/v1/capabilities')
 user=identity.user;capabilities=catalog;initialLanguage=personal.language==='en'?'en':'zh'
 if(personal.theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=personal.theme
 installBridge()
}
async function logout(){await client.logout();location.replace('/')}
function Account(){
 const [expanded,setExpanded]=useState(false)
 const [settings,setSettings]=useState(false)
 const [admin,setAdmin]=useState(false)
 const [global,setGlobal]=useState(false)
 const [sources,setSources]=useState(false)
 const [dataResults,setDataResults]=useState(false)
 const [sessionVersion,setSessionVersion]=useState(0)
 const web:WebSettingsAdapter={
  accountLabel:'本地账号',load:preferences.getPreferences,save:preferences.updatePreferences,
  account:<>
   <h3 className="set-pane-title">个人工作区</h3>
   <p className="set-pane-desc">管理个人显示偏好、账户安全与文件。</p>
   <div className="set-field"><span className="set-field-label">账号</span><span>{user?.username}</span></div>
   <div className="set-field"><span className="set-field-label">显示名称</span><span>{user?.displayName}</span></div>
   <LocalPasswordForm changePassword={async(current,next)=>{await client.changePassword(current,next);setSessionVersion(version=>version+1)}} reload={()=>location.reload()}/>
   <LocalSessionsPanel key={sessionVersion} onCurrentRevoked={()=>{client.invalidateSession();location.replace('/')}}/>
   <LoginHistoryPanel/>
   <div className="set-pane-footer"><button className="set-btn danger" onClick={()=>void logout().catch(e=>notice(e.message))}>退出登录</button></div>
  </>,
 }
 return <div className="account-entry">
  <button className="account-btn" onClick={()=>setExpanded(!expanded)}><span className="account-avatar">{(user?.displayName||user?.username||'U').slice(0,1)}</span><span className="account-text"><span className="account-name">{user?.displayName||user?.username}</span><span className="account-sub">个人工作区</span></span></button>
  {settings&&<SettingsModal web={web} status={null} loggingOut={false} loginWaiting={false} loginUrl={null} urlCopied={false} onOpenLoginUrl={()=>{}} onCopyLoginUrl={()=>{}} onClose={()=>setSettings(false)} onLogin={()=>{}} onLogout={()=>void logout().catch(e=>notice(e.message))}/>}
  {admin&&user?.roles.includes('config_admin')&&<div className="set-overlay"><div className="set-dialog" role="dialog" aria-modal="true" aria-label="用户管理"><div className="set-header"><h2 className="set-title">用户管理</h2></div><div className="set-body"><LocalAdminPanel currentUserId={user.id} onSessionRotated={client.invalidateCsrf} onOwnAuthorityChanged={()=>{client.invalidateSession();location.replace('/')}} onClose={()=>setAdmin(false)}/></div></div></div>}
  {global&&user?.roles.includes('config_admin')&&<div className="set-overlay"><section className="set-dialog" role="dialog" aria-modal="true" aria-label="全局配置"><GlobalSettingsPanel client={globalSettings} onClose={()=>setGlobal(false)}/></section></div>}
  {sources&&<SourcesPanel client={sourcesClient} resultsClient={sourceResultsClient} onClose={()=>setSources(false)}/>}
  {dataResults&&<WorkspaceDataResults client={sourceResultsClient} onClose={()=>setDataResults(false)}/>}
  {expanded&&<div className="web-account-menu">
   <button onClick={()=>{setExpanded(false);setSettings(true)}}>个人设置</button>
   <button onClick={()=>{setExpanded(false);showTrash()}}>回收站</button>
   <button onClick={()=>{setExpanded(false);setSources(true)}}>数据源管理</button>
   <button onClick={()=>{setExpanded(false);setDataResults(true)}}>工作区数据结果</button>
   {user?.roles.includes('config_admin')&&<><button onClick={()=>{setExpanded(false);setSettings(false);setGlobal(true)}}>全局配置</button><button onClick={()=>{setExpanded(false);setSettings(false);setAdmin(true)}}>用户管理</button></>}
   <button onClick={()=>void logout().catch(e=>notice(e.message))}>退出登录</button>
  </div>}
 </div>
}
function Shell(){
 const [message,setMessage]=useState(''),[trash,setTrash]=useState(false)
 notice=setMessage;showTrash=()=>setTrash(true)
 return <>
  <AppFrame initialOnboardingSeen={true} homeProps={{supportedFormats:['docx','xlsx','pptx','pdf'],supportedNewFormats:capabilities.docx==='editable'?['docx']:[],accountEntry:<Account/>,askEnabled:false,folderDeleteDescription:name=>`仅可删除空文件夹「${name}」。请先移出文件和子文件夹；回收站中仍属于此目录的文件需先恢复并移出。`}} editorContent={null}/>
  {trash&&<WorkspaceTrash request={client.request} onChanged={notifyFilesChanged} onClose={()=>setTrash(false)}/>}
  {message&&<div className="web-notice" role="alert">{message}<button onClick={()=>setMessage('')}>关闭</button></div>}
 </>
}
function Login({done}:{done:()=>void}){const [error,setError]=useState('');const [pending,setPending]=useState(false);const [signed,setSigned]=useState(false);const [action,setAction]=useState(false);if(action&&!signed)return <div className="set-overlay"><div className="set-dialog" role="dialog" aria-modal="true" aria-label="激活或重置密码"><div className="set-header"><h2 className="set-title">GenOffice</h2></div><div className="set-body"><PasswordActionForm onClose={()=>{setAction(false);client.invalidateCsrf()}}/></div></div></div>;return <main className="web-login"><h1>GenOffice</h1><p>本地账号登录</p><form onSubmit={async e=>{e.preventDefault();if(pending)return;setPending(true);setError('');const form=e.currentTarget;const data=new FormData(form);try{if(!signed){await client.login(String(data.get('username')||''),String(data.get('password')||''));setSigned(true);form.reset()}await restore();done()}catch(err){setError((err as Error).message)}finally{setPending(false)}}}><input aria-label="用户名" name="username" autoComplete="username" required={!signed} disabled={pending||signed}/><input aria-label="密码" name="password" type="password" autoComplete="current-password" required={!signed} disabled={pending||signed}/><button disabled={pending}>{signed?'重新加载工作区':'登录'}</button>{signed&&<button type="button" disabled={pending} onClick={()=>void logout().catch(e=>setError(e.message))}>退出登录</button>}<p role="alert">{error}</p></form>{!signed&&<button type="button" disabled={pending} onClick={()=>setAction(true)}>激活或重置密码</button>}</main>}
function Root(){const [state,setState]=useState<'loading'|'login'|'ready'|'error'>('loading');const [error,setError]=useState('');useEffect(()=>{void restore().then(()=>setState('ready')).catch(e=>{if(e.status===401)setState('login');else{setError(e.message);setState('error')}})},[]);if(state==='loading')return <main className="web-login">正在加载个人工作区…</main>;if(state==='error')return <main className="web-login" role="alert"><p>{error}</p><button onClick={()=>location.reload()}>重试</button><button onClick={()=>void logout().catch(e=>setError(e.message))}>退出登录</button></main>;return state==='ready'?<LocaleProvider initial={initialLanguage} onError={error=>notice(error instanceof Error?error.message:String(error))}><Shell/></LocaleProvider>:<Login done={()=>setState('ready')}/>}
installScreenTips()
window.addEventListener('unhandledrejection',event=>{notice(event.reason instanceof Error?event.reason.message:String(event.reason));event.preventDefault()})
createRoot(document.getElementById('app')!).render(<Root/>)
