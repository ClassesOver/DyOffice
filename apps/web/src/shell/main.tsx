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
import {createWebHomeBridge,type WebFile} from './web-home-bridge'
import blankDocx from '../../../shell/build/shell-new/blank.docx?url'
import blankXlsx from '../../../shell/build/shell-new/blank.xlsx?url'
import blankPptx from '../../../shell/build/shell-new/blank.pptx?url'

declare global {interface Window {dyofficeEditorCanClose?:()=>boolean;dyofficeEditorDiscard?:()=>void}}
const key='dyoffice-user-token'
function canCloseFrames(id?:string){const frames=[...document.querySelectorAll<HTMLIFrameElement>('.web-editor-frame')].filter(frame=>!id||frame.dataset.tabId===id);if(!frames.every(frame=>frame.contentWindow?.dyofficeEditorCanClose?.()??true))return false;frames.forEach(frame=>frame.contentWindow?.dyofficeEditorDiscard?.());return true}
let token=sessionStorage.getItem(key)||''
let initialLanguage:'zh'|'en'='zh'
let notice=(message:string)=>window.alert(message)
const tabs:TabSummary[]=[{id:'home',kind:'home',title:'首页',active:true,closable:false}]
const listeners=new Set<(tabs:TabSummary[])=>void>()
const emit=()=>listeners.forEach(fn=>fn(tabs.map(t=>({...t}))))
async function request(path:string,method='GET',body?:unknown){
 const response=await fetch('/api'+path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})
 const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败');return value
}
const activate=async(id:string)=>{tabs.forEach(t=>t.active=t.id===id);emit()}
async function open(id:string){const files=await request('/files') as WebFile[];const file=files.find(f=>f.id===id);if(!file)throw new Error('文件不存在');if(!tabs.some(t=>t.id===id))tabs.push({id,kind:({docx:'docs',xlsx:'sheets',pptx:'slides',pdf:'pdf'} as const)[file.format as 'docx'],title:file.name,active:false,closable:true,filePath:id});await activate(id)}
async function upload(file:File){const response=await fetch('/api/files',{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-File-Name':encodeURIComponent(file.name)},body:file});const result=await response.json();if(!response.ok)throw new Error(result.error||'导入失败');notifyFilesChanged();await open(result.id)}
async function browse(){const input=document.createElement('input');input.type='file';input.accept='.docx,.xlsx,.pptx,.pdf';input.onchange=()=>{const file=input.files?.[0];if(file)void upload(file).catch(e=>notice(e.message))};input.click()}
window.aiOffice=createWebHomeBridge({request,open,changed:notifyFilesChanged,unsupported:m=>notice(m),browse})
for(const [method,url,ext] of [['newDoc',blankDocx,'docx'],['newSheet',blankXlsx,'xlsx'],['newSlide',blankPptx,'pptx']] as const){window.aiOffice[method]=async()=>{const response=await fetch(url);if(!response.ok)throw new Error('原版空白模板不可用');await upload(new File([await response.blob()],`未命名.${ext}`))}}
const unsupported=async()=>{notice('此桌面操作尚未适配到 Web。');throw new Error('Unsupported native operation')}
window.aiOfficeTabs={list:async()=>tabs.map(t=>({...t})),activate,close:async id=>{const index=tabs.findIndex(t=>t.id===id);if(index<1)return;if(!canCloseFrames(id))return;tabs.splice(index,1);await activate('home')},onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},showNewMenu:browse,showAppMenu:async()=>notice('使用首页打开或新建文档；账户菜单可切换主题。'),showMenu:async()=>activate('home'),showTabMenu:unsupported,detach:unsupported,tearOff:async()=>false,dragTornWindow:()=>{},dockTornWindow:unsupported,endTornDrag:async()=>{},onDockPreview:()=>()=>{},reportDockIndex:()=>{},reorder:async(id,index)=>{const from=tabs.findIndex(t=>t.id===id);if(from<1)return;const [tab]=tabs.splice(from,1);tabs.splice(Math.max(1,index),0,tab);emit()},notifyChromePressed:()=>{},onChromePressed:()=>()=>{}} satisfies TabsApi
installScreenTips()
window.addEventListener('unhandledrejection',event=>{notice(event.reason instanceof Error?event.reason.message:String(event.reason));event.preventDefault()})
function Account(){const [expanded,setExpanded]=useState(false);const [settings,setSettings]=useState(false);const logout=()=>{if(!canCloseFrames())return;sessionStorage.removeItem(key);location.reload()};const web:WebSettingsAdapter={load:()=>request('/preferences'),save:patch=>request('/preferences','PUT',patch),account:<><h3 className="set-pane-title">个人工作区</h3><p className="set-pane-desc">当前通过开发访问令牌访问个人数据，不是 Genspark 账户登录。</p><div className="set-field"><span className="set-field-label">访问方式</span><span>个人开发访问令牌</span></div><div className="set-pane-footer"><button className="set-btn danger" onClick={logout}>退出登录</button></div></>};return <div className="account-entry"><button className="account-btn" onClick={()=>setExpanded(!expanded)}><span className="account-avatar">D</span><span className="account-text"><span className="account-name">个人工作区</span><span className="account-sub">收藏仅保留在当前页面会话</span></span></button>{settings&&<SettingsModal web={web} status={null} loggingOut={false} loginWaiting={false} loginUrl={null} urlCopied={false} onOpenLoginUrl={()=>{}} onCopyLoginUrl={()=>{}} onClose={()=>setSettings(false)} onLogin={()=>{}} onLogout={logout}/>}{expanded&&<div className="web-account-menu"><button onClick={()=>{setExpanded(false);setSettings(true)}}>个人设置</button><label>主题<select aria-label="主题" defaultValue={document.documentElement.dataset.theme||'system'} onChange={async e=>{const theme=e.target.value as 'system'|'light'|'dark';await window.aiOffice.setTheme(theme);if(theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=theme}}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><a href="/admin" onClick={event=>{if(!canCloseFrames())event.preventDefault()}}>Admin 管理（独立权限）</a><button onClick={()=>{if(!canCloseFrames())return;sessionStorage.removeItem(key);location.reload()}}>退出登录</button></div>}</div>}
function Shell(){const [message,setMessage]=useState('');const [openTabs,setOpenTabs]=useState(tabs.map(t=>({...t})));useEffect(()=>window.aiOfficeTabs.onChanged(setOpenTabs),[]);notice=setMessage;return <><AppFrame initialOnboardingSeen={true} homeProps={{supportedFormats:['docx','xlsx','pptx','pdf'],supportedNewFormats:['docx','xlsx','pptx'],accountEntry:<Account/>}} editorContent={openTabs.filter(t=>t.id!=='home').map(tab=><iframe key={tab.id} data-tab-id={tab.id} title={tab.title} hidden={!tab.active} className="web-editor-frame" src={`${tab.kind==='pdf'?'/pdf.html':'/legacy.html'}?file=${encodeURIComponent(tab.id)}`}/>)}/>{message&&<div className="web-notice" role="alert">{message}<button onClick={()=>setMessage('')}>关闭</button></div>}</>}
function Login({done}:{done:()=>void}){const [error,setError]=useState('');return <main className="web-login"><h1>GenOffice</h1><p>个人工作区开发访问令牌</p><form onSubmit={async e=>{e.preventDefault();const data=new FormData(e.currentTarget);token=String(data.get('token')||'');try{const preferences=await request('/preferences');initialLanguage=preferences.language==='en'?'en':'zh';if(preferences.theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=preferences.theme;sessionStorage.setItem(key,token);done()}catch(err){token='';setError((err as Error).message)}}}><input aria-label="个人访问令牌" name="token" type="password" required autoComplete="off"/><button>登录</button><p role="alert">{error}</p></form></main>}
function Root(){const [ready,setReady]=useState(Boolean(token));return ready?<LocaleProvider initial={initialLanguage} onError={error=>notice(error instanceof Error?error.message:String(error))}><Shell/></LocaleProvider>:<Login done={()=>setReady(true)}/>}
void (async()=>{if(token){try{const preferences=await request('/preferences');initialLanguage=preferences.language==='en'?'en':'zh';if(preferences.theme!=='system')document.documentElement.dataset.theme=preferences.theme}catch{token='';sessionStorage.removeItem(key)}}createRoot(document.getElementById('app')!).render(<Root/>)})()
