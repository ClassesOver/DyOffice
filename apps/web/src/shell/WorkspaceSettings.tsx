import './personal-settings-b.css'
import {useCallback,useEffect,useId,useRef,useState} from 'react'
import {Alert,Button,Card,Descriptions,Form,Input,Select,Space,Switch,Typography} from 'antd'
import type {WebSettingsPreferences} from '../../../shell/src/renderer/src/SettingsModal'
import {LocalPasswordForm} from './LocalPasswordForm'
import {LocalSessionsPanel} from './LocalSessionsPanel'
import type {LocalSessionsClient} from './local-sessions-client'
import type {LoginHistoryClient} from './local-login-history-client'
import {LoginHistoryPanel} from './LoginHistoryPanel'
import type {ReactNode} from 'react'
import {SafetyCertificateOutlined,SlidersOutlined,AppstoreOutlined,UserOutlined,LockOutlined,DesktopOutlined,HistoryOutlined} from '@ant-design/icons'
import {SettingsWorkbench} from './SettingsWorkbench'
const {Paragraph}=Typography
export function WorkspaceSettings({user,load,save,security,skills,onLogout,onClose,onCloseGuardChange,sessionsClient,historyClient,activeTab,onTabChange}:{
 user:{username:string;displayName:string;roles:string[]};load:()=>Promise<WebSettingsPreferences>;save:(patch:Partial<WebSettingsPreferences>)=>Promise<WebSettingsPreferences>
 activeTab?:string;onTabChange?:(tab:string)=>void
 sessionsClient?:LocalSessionsClient;historyClient?:LoginHistoryClient
 security:{changePassword:(current:string,next:string)=>Promise<void>;onCurrentRevoked:()=>void};skills:ReactNode|((registerGuard:(guard:(()=>boolean)|null)=>void)=>ReactNode);onLogout:()=>void;onClose:()=>void;onCloseGuardChange:(guard:(()=>boolean)|null)=>void
}){
 const preferenceId=useId()
 const [localTab,setLocalTab]=useState('account')
 const selectedTab=activeTab??localTab
 const tabTitles:Record<string,[string,string]>={account:['账户与安全','管理个人资料、密码与登录活动。'],general:['通用偏好','让工作区更贴合你的习惯。'],skills:['个人技能','管理和扩展你的个人办公技能。']}
 const [baseline,setBaseline]=useState<WebSettingsPreferences|null>(null),[draft,setDraft]=useState<WebSettingsPreferences|null>(null)
 const [sessionVersion,setSessionVersion]=useState(0)
 const [operation,setOperation]=useState<'load'|'save'|null>('load')
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false)
 const lock=useRef(false),alive=useRef(true)
 const securityGuards=useRef<{password:(()=>boolean)|null;sessions:(()=>boolean)|null;skills:(()=>boolean)|null}>({password:null,sessions:null,skills:null})
 const passwordGuard=useCallback((guard:(()=>boolean)|null)=>{securityGuards.current.password=guard},[])
 const sessionsGuard=useCallback((guard:(()=>boolean)|null)=>{securityGuards.current.sessions=guard},[])
 const skillsGuard=useCallback((guard:(()=>boolean)|null)=>{securityGuards.current.skills=guard},[])
 const dirty=!!draft&&JSON.stringify(draft)!==JSON.stringify(baseline)
 function guard(){if(lock.current)return false;for(const check of Object.values(securityGuards.current))if(check?.()===false)return false;return !dirty||window.confirm('个人偏好尚未保存，是否放弃更改并关闭？')}
 useEffect(()=>{onCloseGuardChange(guard);return()=>onCloseGuardChange(null)},[onCloseGuardChange,dirty])
 async function refresh(){if(lock.current)return;if(dirty&&!window.confirm('重新读取会放弃未保存的个人偏好，是否继续？'))return;lock.current=true;setBusy(true);setOperation('load');setError('');try{const next=await load();if(alive.current){setBaseline(next);setDraft(next);setSaved(false)}}catch(e){if(alive.current)setError((e as Error).message)}finally{lock.current=false;if(alive.current){setBusy(false);setOperation(null)}}}
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false}},[])
 function edit(patch:Partial<WebSettingsPreferences>){setDraft(current=>current?{...current,...patch}:current);setSaved(false);setError('')}
 function revert(){if(busy||!baseline)return;setDraft(baseline);setSaved(false);setError('')}
 async function commit(){if(lock.current||!draft||!baseline||!dirty)return;const patch=Object.fromEntries(Object.entries(draft).filter(([key,value])=>value!==baseline[key as keyof WebSettingsPreferences])) as Partial<WebSettingsPreferences>;lock.current=true;setBusy(true);setOperation('save');setError('');try{const next=await save(patch);if(!alive.current)return;setBaseline(next);setDraft(next);setSaved(true);if(next.theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=next.theme}catch(e){if(alive.current)setError((e as Error).message)}finally{lock.current=false;if(alive.current){setBusy(false);setOperation(null)}}}
 useEffect(()=>{if(!dirty)return;const prevent=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[dirty])
 const account=<Space className="personal-settings-account" orientation="vertical" size={20} style={{width:'100%'}}>
  <Card className="personal-settings-profile" title={<Space size={8}><UserOutlined aria-hidden="true"/>个人资料</Space>}><Descriptions layout="vertical" column={{xs:1,sm:3}} items={[{key:'username',label:'用户名',children:user.username},{key:'name',label:'显示名称',children:user.displayName||user.username},{key:'roles',label:'账号角色',children:user.roles.map(role=>({personal:'个人用户',config_admin:'配置管理员',operator:'运维人员',auditor:'审计人员'}[role]||role)).join(' · ')}]}/></Card>
  <Card className="personal-settings-password" title={<Space size={8}><LockOutlined aria-hidden="true"/>密码与安全</Space>}><LocalPasswordForm onCloseGuardChange={passwordGuard} changePassword={async(current,next)=>{await security.changePassword(current,next);setSessionVersion(version=>version+1)}} reload={()=>location.reload()}/></Card>
  <Card className="personal-settings-sessions" title={<Space size={8}><DesktopOutlined aria-hidden="true"/>登录会话</Space>}><LocalSessionsPanel client={sessionsClient} refreshVersion={sessionVersion} onCloseGuardChange={sessionsGuard} onCurrentRevoked={security.onCurrentRevoked}/></Card>
  <Card className="personal-settings-history" title={<Space size={8}><HistoryOutlined aria-hidden="true"/>登录记录</Space>}><LoginHistoryPanel client={historyClient}/></Card>
  <Card className="personal-settings-logout"><Space style={{width:'100%',justifyContent:'space-between'}} wrap><div><Typography.Text strong>退出当前账号</Typography.Text><Paragraph type="secondary" style={{marginBottom:0}}>仅退出此浏览器，其他会话保持有效。</Paragraph></div><Button danger onClick={()=>{if(guard())onLogout()}}>退出登录</Button></Space></Card>
 </Space>
 const general=<div className="personal-settings-general">
  <Form layout="vertical" disabled={busy||!draft} onFinish={()=>void commit()} aria-busy={busy}>
   <h3 className="personal-settings-group-title">外观与语言</h3>
   <Form.Item label="语言" htmlFor={`${preferenceId}-language`}><Select id={`${preferenceId}-language`} aria-label="语言" value={draft?.language} options={[{value:'zh',label:'简体中文'},{value:'en',label:'English'}]} onChange={language=>edit({language})}/></Form.Item>
   <fieldset className="personal-settings-theme" aria-label="主题" disabled={busy||!draft}><legend>主题</legend><div className="personal-settings-theme-options">{([{value:'light',label:'浅色'},{value:'dark',label:'深色'},{value:'system',label:'跟随系统'}] as const).map(option=><label key={option.value} className={`personal-settings-theme-choice theme-preview-${option.value}`}><input type="radio" name={`${preferenceId}-theme`} value={option.value} checked={draft?.theme===option.value} onChange={()=>edit({theme:option.value})}/><span className="personal-settings-theme-preview" aria-hidden="true"><span className="theme-preview-nav"><b>D</b><i/><i/><i/></span><span className="theme-preview-content"><i/><i/><i/></span><span className="theme-preview-check">✓</span></span><span>{option.label}</span></label>)}</div></fieldset>
   <h3 className="personal-settings-group-title personal-settings-group-divider">编辑偏好</h3>
   <Form.Item label="文档作者" htmlFor={`${preferenceId}-author`} extra="作为文档批注与修订的作者名称。"><Input id={`${preferenceId}-author`} aria-label="文档作者" value={draft?.authorName} maxLength={100} onChange={e=>edit({authorName:e.target.value})}/></Form.Item>
   <Form.Item className="personal-settings-switch-row" label="自动保存" htmlFor={`${preferenceId}-autosave`}><Switch id={`${preferenceId}-autosave`} aria-label="自动保存" checked={draft?.autoSave} onChange={autoSave=>edit({autoSave})}/></Form.Item>
   <Form.Item className="personal-settings-switch-row" label="显示 AI 助手" htmlFor={`${preferenceId}-assistant`}><Switch id={`${preferenceId}-assistant`} aria-label="显示 AI 助手" checked={draft?.showAssistant} onChange={showAssistant=>edit({showAssistant})}/></Form.Item>
  <Typography.Text type="secondary">语言与编辑器偏好保存后，在刷新页面或重新打开文档时生效。</Typography.Text>
  </Form>
 </div>
 const activeContent=selectedTab==='account'?account:selectedTab==='general'?general:<div className="personal-settings-skills">{typeof skills==='function'?skills(skillsGuard):skills}</div>
 const operationStatus=operation==='load'?'正在读取个人偏好…':operation==='save'?'正在保存…':!draft?'个人偏好读取失败，请重新读取':dirty?'有未保存的更改':saved?'个人偏好已保存':'所有更改已保存'
 return <section className="personal-settings-b">
 <SettingsWorkbench ariaLabel="个人设置" caption="个人设置" footer={<><SafetyCertificateOutlined/><span>个人工作区配置<br/>仅对当前账号生效</span></>} navigation={[{key:'account',label:'账户与安全',icon:<SafetyCertificateOutlined/>},{key:'general',label:'通用偏好',icon:<SlidersOutlined/>},{key:'skills',label:'个人技能',icon:<AppstoreOutlined/>}]} activeKey={selectedTab} onNavigationChange={tab=>{setLocalTab(tab);onTabChange?.(tab)}} title={tabTitles[selectedTab][0]} description={tabTitles[selectedTab][1]} status={<span className={`personal-settings-save-state${dirty?' is-dirty':''}`} role="status" aria-live="polite">{operationStatus}</span>} actions={<><Button disabled={busy} onClick={()=>void refresh()}>重新读取</Button><Button disabled={busy||!dirty} onClick={revert}>撤销更改</Button><Button type="primary" loading={operation==='save'} disabled={busy||!dirty} onClick={()=>void commit()}>保存个人偏好</Button></>}>
   {error&&<Alert type="error" showIcon role="alert" title={error}/>}{saved&&<Alert type="success" showIcon role="status" title="个人偏好已保存"/>}{activeContent}
 </SettingsWorkbench>
 </section>
}
