import {useCallback,useEffect,useRef,useState} from 'react'
import {Alert,Button,Card,Descriptions,Form,Input,Select,Space,Switch,Tabs,Typography} from 'antd'
import type {WebSettingsPreferences} from '../../../shell/src/renderer/src/SettingsModal'
import {LocalPasswordForm} from './LocalPasswordForm'
import {LocalSessionsPanel} from './LocalSessionsPanel'
import type {LocalSessionsClient} from './local-sessions-client'
import type {LoginHistoryClient} from './local-login-history-client'
import {LoginHistoryPanel} from './LoginHistoryPanel'
import type {ReactNode} from 'react'
import {SafetyCertificateOutlined,SlidersOutlined,AppstoreOutlined,UserOutlined,LockOutlined,DesktopOutlined,HistoryOutlined} from '@ant-design/icons'
const {Paragraph}=Typography
export function WorkspaceSettings({user,load,save,security,skills,onLogout,onClose,onCloseGuardChange,sessionsClient,historyClient}:{
 user:{username:string;displayName:string;roles:string[]};load:()=>Promise<WebSettingsPreferences>;save:(patch:Partial<WebSettingsPreferences>)=>Promise<WebSettingsPreferences>
 sessionsClient?:LocalSessionsClient;historyClient?:LoginHistoryClient
 security:{changePassword:(current:string,next:string)=>Promise<void>;onCurrentRevoked:()=>void};skills:ReactNode|((registerGuard:(guard:(()=>boolean)|null)=>void)=>ReactNode);onLogout:()=>void;onClose:()=>void;onCloseGuardChange:(guard:(()=>boolean)|null)=>void
}){
 const [baseline,setBaseline]=useState<WebSettingsPreferences|null>(null),[draft,setDraft]=useState<WebSettingsPreferences|null>(null)
 const [sessionVersion,setSessionVersion]=useState(0)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false)
 const lock=useRef(false),alive=useRef(true)
 const securityGuards=useRef<{password:(()=>boolean)|null;sessions:(()=>boolean)|null;skills:(()=>boolean)|null}>({password:null,sessions:null,skills:null})
 const passwordGuard=useCallback((guard:(()=>boolean)|null)=>{securityGuards.current.password=guard},[])
 const sessionsGuard=useCallback((guard:(()=>boolean)|null)=>{securityGuards.current.sessions=guard},[])
 const skillsGuard=useCallback((guard:(()=>boolean)|null)=>{securityGuards.current.skills=guard},[])
 const dirty=!!draft&&JSON.stringify(draft)!==JSON.stringify(baseline)
 function guard(){if(lock.current)return false;for(const check of Object.values(securityGuards.current))if(check?.()===false)return false;return !dirty||window.confirm('个人偏好尚未保存，是否放弃更改并关闭？')}
 useEffect(()=>{onCloseGuardChange(guard);return()=>onCloseGuardChange(null)},[onCloseGuardChange,dirty])
 async function refresh(){if(lock.current)return;if(dirty&&!window.confirm('重新读取会放弃未保存的个人偏好，是否继续？'))return;lock.current=true;setBusy(true);setError('');try{const next=await load();if(alive.current){setBaseline(next);setDraft(next);setSaved(false)}}catch(e){if(alive.current)setError((e as Error).message)}finally{lock.current=false;if(alive.current)setBusy(false)}}
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false}},[])
 function edit(patch:Partial<WebSettingsPreferences>){setDraft(current=>current?{...current,...patch}:current);setSaved(false)}
 async function commit(){if(lock.current||!draft||!baseline||!dirty)return;const patch=Object.fromEntries(Object.entries(draft).filter(([key,value])=>value!==baseline[key as keyof WebSettingsPreferences])) as Partial<WebSettingsPreferences>;lock.current=true;setBusy(true);setError('');try{const next=await save(patch);if(!alive.current)return;setBaseline(next);setDraft(next);setSaved(true);if(next.theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=next.theme}catch(e){if(alive.current)setError((e as Error).message)}finally{lock.current=false;if(alive.current)setBusy(false)}}
 useEffect(()=>{if(!dirty)return;const prevent=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[dirty])
 const account=<Space className="personal-settings-account" orientation="vertical" size={20} style={{width:'100%'}}>
  <Card className="personal-settings-profile" title={<Space size={8}><UserOutlined aria-hidden="true"/>个人资料</Space>}><Descriptions layout="vertical" column={{xs:1,sm:3}} items={[{key:'username',label:'用户名',children:user.username},{key:'name',label:'显示名称',children:user.displayName||user.username},{key:'roles',label:'账号角色',children:user.roles.map(role=>({personal:'个人用户',config_admin:'配置管理员',operator:'运维人员',auditor:'审计人员'}[role]||role)).join(' · ')}]}/></Card>
  <Card className="personal-settings-password" title={<Space size={8}><LockOutlined aria-hidden="true"/>密码与安全</Space>}><LocalPasswordForm onCloseGuardChange={passwordGuard} changePassword={async(current,next)=>{await security.changePassword(current,next);setSessionVersion(version=>version+1)}} reload={()=>location.reload()}/></Card>
  <Card className="personal-settings-sessions" title={<Space size={8}><DesktopOutlined aria-hidden="true"/>登录会话</Space>}><LocalSessionsPanel client={sessionsClient} key={sessionVersion} onCloseGuardChange={sessionsGuard} onCurrentRevoked={security.onCurrentRevoked}/></Card>
  <Card className="personal-settings-history" title={<Space size={8}><HistoryOutlined aria-hidden="true"/>登录记录</Space>}><LoginHistoryPanel client={historyClient}/></Card>
  <Card className="personal-settings-logout"><Space style={{width:'100%',justifyContent:'space-between'}} wrap><div><Typography.Text strong>退出当前账号</Typography.Text><Paragraph type="secondary" style={{marginBottom:0}}>仅退出此浏览器，其他会话保持有效。</Paragraph></div><Button danger onClick={()=>{if(guard())onLogout()}}>退出登录</Button></Space></Card>
 </Space>
 const general=<Card className="personal-settings-general" title="显示与文档偏好" extra={<Space><Button disabled={busy} onClick={()=>void refresh()}>重新读取</Button><Button type="primary" loading={busy} disabled={!dirty} onClick={()=>void commit()}>保存个人偏好</Button></Space>}>
  <Form layout="vertical" style={{maxWidth:540}} disabled={busy||!draft}>
   <Form.Item label="语言"><Select aria-label="语言" value={draft?.language} options={[{value:'zh',label:'简体中文'},{value:'en',label:'English'}]} onChange={language=>edit({language})}/></Form.Item>
   <Form.Item label="主题"><Select aria-label="主题" value={draft?.theme} options={[{value:'system',label:'跟随系统'},{value:'light',label:'浅色'},{value:'dark',label:'深色'}]} onChange={theme=>edit({theme})}/></Form.Item>
   <Form.Item label="文档作者" extra="作为文档批注与修订的作者名称。"><Input aria-label="文档作者" value={draft?.authorName} maxLength={100} onChange={e=>edit({authorName:e.target.value})}/></Form.Item>
   <Form.Item label="自动保存"><Switch aria-label="自动保存" checked={draft?.autoSave} onChange={autoSave=>edit({autoSave})}/></Form.Item>
   <Form.Item label="显示 AI 助手"><Switch aria-label="显示 AI 助手" checked={draft?.showAssistant} onChange={showAssistant=>edit({showAssistant})}/></Form.Item>
  </Form>
  <Typography.Text type="secondary">语言与编辑器偏好保存后，在刷新页面或重新打开文档时生效。</Typography.Text>
 </Card>
 return <section className="workspace-settings-page"><header className="workspace-page-heading"><Paragraph type="secondary">管理你的账号安全、显示偏好与个人技能。</Paragraph></header>
 {error&&<Alert type="error" showIcon title={error} style={{marginBottom:16}}/>}{saved&&<Alert type="success" showIcon title="个人偏好已保存" style={{marginBottom:16}}/>}
 <Tabs className="personal-settings-tabs" items={[{key:'account',icon:<SafetyCertificateOutlined aria-hidden="true"/>,label:'账户与安全',children:account},{key:'general',icon:<SlidersOutlined aria-hidden="true"/>,label:'通用偏好',children:general},{key:'skills',icon:<AppstoreOutlined aria-hidden="true"/>,label:'个人技能',children:<div className="personal-settings-skills">{typeof skills==='function'?skills(skillsGuard):skills}</div>}]} destroyOnHidden={false}/>
 </section>
}
