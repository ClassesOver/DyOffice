import './personal-settings-page.css'
import {useCallback,useEffect,useId,useRef,useState} from 'react'
import type {PersonalPreferences} from '../../../../packages/browser-host/src/preferences'
import {AI_CUSTOM_FONT_MAX_PX,AI_CUSTOM_FONT_MIN_PX,DEFAULT_AI_PANEL_PREFS,aiPanelFontPx,type AiFontSize} from '@genoffice/ui/ai-panel-prefs'
import {LocalPasswordForm} from './LocalPasswordForm'
import {LocalSessionsPanel} from './LocalSessionsPanel'
import type {LocalSessionsClient} from './local-sessions-client'
import type {LoginHistoryClient} from './local-login-history-client'
import {LoginHistoryPanel} from './LoginHistoryPanel'
import type {KeyboardEvent,ReactNode} from 'react'
const customAssistantSizes=Array.from({length:AI_CUSTOM_FONT_MAX_PX-AI_CUSTOM_FONT_MIN_PX+1},(_,index)=>AI_CUSTOM_FONT_MIN_PX+index)
export function WorkspaceSettings({user,load,save,security,skills,onLogout,onClose,onCloseGuardChange,sessionsClient,historyClient,activeTab,onTabChange}:{
 user:{username:string;displayName:string;roles:string[]};load:()=>Promise<PersonalPreferences>;save:(patch:Partial<PersonalPreferences>)=>Promise<PersonalPreferences>
 activeTab?:string;onTabChange?:(tab:string)=>void
 sessionsClient?:LocalSessionsClient;historyClient?:LoginHistoryClient
 security:{changePassword:(current:string,next:string)=>Promise<void>;onCurrentRevoked:()=>void};skills:ReactNode|((registerGuard:(guard:(()=>boolean)|null)=>void)=>ReactNode);onLogout:()=>void;onClose:()=>void;onCloseGuardChange:(guard:(()=>boolean)|null)=>void
}){
 const preferenceId=useId()
 const [localTab,setLocalTab]=useState('account')
 const selectedTab=['account','activity','general','skills'].includes(activeTab??localTab)?(activeTab??localTab):'account'
 const contentRef=useRef<HTMLDivElement>(null)
 useEffect(()=>{if(contentRef.current)contentRef.current.scrollTop=0},[selectedTab])
 const visitedTabs=useRef(new Set<string>())
 visitedTabs.current.add(selectedTab)
 const tabTitles:Record<string,[string,string]>={account:['资料与安全','查看账号资料，管理密码与登录状态。'],activity:['登录活动','查看有效会话与已保留的登录记录。'],general:['通用偏好','调整外观、语言与编辑习惯。'],skills:['个人技能','管理和扩展你的个人办公技能。']}
 const [baseline,setBaseline]=useState<PersonalPreferences|null>(null),[draft,setDraft]=useState<PersonalPreferences|null>(null)
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
 function edit(patch:Partial<PersonalPreferences>){setDraft(current=>current?{...current,...patch}:current);setSaved(false);setError('')}
 function revert(){if(busy||!baseline)return;setDraft(baseline);setSaved(false);setError('')}
 async function commit(){if(lock.current||!draft||!baseline||!dirty)return;const patch=Object.fromEntries(Object.entries(draft).filter(([key,value])=>value!==baseline[key as keyof PersonalPreferences])) as Partial<PersonalPreferences>;lock.current=true;setBusy(true);setOperation('save');setError('');try{const next=await save(patch);if(!alive.current)return;setBaseline(next);setDraft(next);setSaved(true);if(next.theme==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=next.theme}catch(e){if(alive.current)setError((e as Error).message)}finally{lock.current=false;if(alive.current){setBusy(false);setOperation(null)}}}
 useEffect(()=>{if(!dirty)return;const prevent=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[dirty])
 const account=<div className="personal-page-account-grid">
  <div className="personal-page-account-summary">
   <section className="personal-page-panel personal-page-profile" aria-labelledby={`${preferenceId}-profile`}><h3 id={`${preferenceId}-profile`}>个人资料</h3><dl className="personal-page-profile-details">{[{label:'用户名',value:user.username},{label:'显示名称',value:user.displayName||user.username},{label:'账号角色',value:user.roles.map(role=>({personal:'个人用户',config_admin:'配置管理员',operator:'运维人员',auditor:'审计人员'}[role]||role)).join(' · ')}].map(item=><div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></section>
  </div>
  <section className="personal-page-panel personal-page-password" aria-labelledby={`${preferenceId}-password`}><h3 id={`${preferenceId}-password`}>密码与安全</h3><LocalPasswordForm onCloseGuardChange={passwordGuard} changePassword={async(current,next)=>{await security.changePassword(current,next);setSessionVersion(version=>version+1)}} reload={()=>location.reload()}/></section>
   <section className="personal-page-logout" aria-label="退出当前账号"><div><strong>退出当前账号</strong><p>仅退出此浏览器，其他会话保持有效。</p></div><button type="button" className="personal-page-button is-danger" onClick={()=>{if(guard())onLogout()}}>退出登录</button></section>
 </div>
 const activity=<div className="personal-page-activity-grid">
  <section className="personal-page-panel personal-page-sessions" aria-labelledby={`${preferenceId}-sessions`}><h3 id={`${preferenceId}-sessions`}>登录会话</h3><LocalSessionsPanel client={sessionsClient} refreshVersion={sessionVersion} onCloseGuardChange={sessionsGuard} onCurrentRevoked={security.onCurrentRevoked}/></section>
  <section className="personal-page-panel personal-page-history" aria-labelledby={`${preferenceId}-history`}><h3 id={`${preferenceId}-history`}>登录记录</h3><LoginHistoryPanel client={historyClient}/></section>
 </div>
 const assistantFontSize=draft?.aiFontSize??DEFAULT_AI_PANEL_PREFS.fontSize
 const general=<form className="personal-page-general" onSubmit={event=>{event.preventDefault();void commit()}} aria-busy={busy}>
  <fieldset disabled={busy||!draft}>
   <h3 className="personal-page-group-title">外观与语言</h3>
   <div className="personal-page-preference-row"><label htmlFor={`${preferenceId}-language`}>语言</label><select id={`${preferenceId}-language`} aria-label="语言" value={draft?.language??'zh'} onChange={event=>edit({language:event.target.value as PersonalPreferences['language']})}><option value="zh">简体中文</option><option value="en">English</option></select></div>
   <fieldset className="personal-page-theme" aria-label="主题"><legend>主题</legend><div className="personal-page-theme-options">{([{value:'light',label:'浅色'},{value:'dark',label:'深色'},{value:'system',label:'跟随系统'}] as const).map(option=><label key={option.value} className={`personal-page-theme-choice theme-preview-${option.value}`}><input type="radio" name={`${preferenceId}-theme`} value={option.value} checked={draft?.theme===option.value} onChange={()=>edit({theme:option.value})}/><span className="personal-page-theme-preview" aria-hidden="true"><span className="theme-preview-nav"><b>D</b><i/><i/><i/></span><span className="theme-preview-content"><i/><i/><i/></span><span className="theme-preview-check">✓</span></span><span>{option.label}</span></label>)}</div></fieldset>
   <div className="personal-page-preference-row">
    <div><label htmlFor={`${preferenceId}-document-theme`}>文档主题</label><p id={`${preferenceId}-document-theme-hint`} className="personal-page-field-hint">设置 Word 页面和 Excel 工作表的显示外观。</p></div>
    <select id={`${preferenceId}-document-theme`} aria-describedby={`${preferenceId}-document-theme-hint`} value={draft?.documentTheme??'follow'} onChange={event=>edit({documentTheme:event.target.value as NonNullable<PersonalPreferences['documentTheme']>})}>
     <option value="follow">跟随应用主题</option><option value="light">浅色</option><option value="dark">深色</option>
    </select>
   </div>
   <h3 className="personal-page-group-title personal-page-group-divider">编辑偏好</h3>
   <div className="personal-page-preference-row"><label htmlFor={`${preferenceId}-author`}>文档作者</label><div><input id={`${preferenceId}-author`} aria-label="文档作者" aria-describedby={`${preferenceId}-author-hint`} value={draft?.authorName??''} maxLength={100} onChange={event=>edit({authorName:event.target.value})}/><p id={`${preferenceId}-author-hint`} className="personal-page-field-hint">作为文档批注与修订的作者名称。</p></div></div>
   <div className="personal-page-preference-row personal-page-switch-row"><label htmlFor={`${preferenceId}-autosave`}>自动保存</label><input className="personal-page-switch" type="checkbox" role="switch" id={`${preferenceId}-autosave`} aria-label="自动保存" aria-checked={!!draft?.autoSave} checked={!!draft?.autoSave} onChange={event=>edit({autoSave:event.target.checked})}/></div>
   <div className="personal-page-preference-row personal-page-switch-row"><label htmlFor={`${preferenceId}-assistant`}>显示 AI 助手</label><input className="personal-page-switch" type="checkbox" role="switch" id={`${preferenceId}-assistant`} aria-label="显示 AI 助手" aria-checked={!!draft?.showAssistant} checked={!!draft?.showAssistant} onChange={event=>edit({showAssistant:event.target.checked})}/></div>
   <div className="personal-page-preference-row">
    <label htmlFor={`${preferenceId}-assistant-font`}>AI 助手字号</label>
    <select id={`${preferenceId}-assistant-font`} value={assistantFontSize} onChange={event=>{
     const aiFontSize=event.target.value as AiFontSize
     edit(aiFontSize==='custom'
      ? {aiFontSize,aiCustomFontSize:aiPanelFontPx({...DEFAULT_AI_PANEL_PREFS,fontSize:assistantFontSize})}
      : {aiFontSize})
    }}>
     <option value="default">默认</option><option value="large">大</option><option value="xlarge">特大</option><option value="custom">自定义</option>
    </select>
   </div>
   {assistantFontSize==='custom'&&<div className="personal-page-preference-row">
    <label htmlFor={`${preferenceId}-assistant-custom-font`}>自定义助手字号</label>
    <select id={`${preferenceId}-assistant-custom-font`} value={draft?.aiCustomFontSize??DEFAULT_AI_PANEL_PREFS.customFontSize} onChange={event=>edit({aiCustomFontSize:Number(event.target.value)})}>
     {customAssistantSizes.map(size=><option key={size} value={size}>{size} px</option>)}
    </select>
   </div>}
   <div className="personal-page-preference-row personal-page-switch-row">
    <div><label htmlFor={`${preferenceId}-assistant-spellcheck`}>AI 助手拼写检查</label><p id={`${preferenceId}-assistant-spellcheck-hint`} className="personal-page-field-hint">检查助手输入框中的拼写。</p></div>
    <input className="personal-page-switch" type="checkbox" role="switch" id={`${preferenceId}-assistant-spellcheck`} aria-describedby={`${preferenceId}-assistant-spellcheck-hint`} checked={draft?.aiSpellcheck!==false} onChange={event=>edit({aiSpellcheck:event.target.checked})}/>
   </div>
   <div className="personal-page-preference-row">
    <div><label htmlFor={`${preferenceId}-pdf-zoom`}>PDF 默认缩放</label><p id={`${preferenceId}-pdf-zoom-hint`} className="personal-page-field-hint">打开没有阅读记录的 PDF 时使用的缩放。</p></div>
    <select id={`${preferenceId}-pdf-zoom`} aria-describedby={`${preferenceId}-pdf-zoom-hint`} value={draft?.pdfDefaultZoom??'width'} onChange={event=>edit({pdfDefaultZoom:event.target.value as NonNullable<PersonalPreferences['pdfDefaultZoom']>})}>
     <option value="width">适应宽度</option><option value="page">适应页面</option><option value="last">上次使用的缩放</option>
    </select>
   </div>
   <div className="personal-page-preference-row personal-page-switch-row">
    <div><label htmlFor={`${preferenceId}-restore`}>重新打开上次的文档</label><p id={`${preferenceId}-restore-hint`} className="personal-page-field-hint">在此浏览器刷新或从首页重新进入工作区时，恢复上次退出时的文档页签和并排布局。</p></div>
    <input className="personal-page-switch" type="checkbox" role="switch" id={`${preferenceId}-restore`} aria-describedby={`${preferenceId}-restore-hint`} checked={draft?.restoreSession!==false} onChange={event=>edit({restoreSession:event.target.checked})}/>
   </div>
   <div className="personal-page-preference-row personal-page-switch-row">
    <div><label htmlFor={`${preferenceId}-sleep`}>休眠不活跃的标签页</label><p id={`${preferenceId}-sleep-hint`} className="personal-page-field-hint">打开较多文档时，释放长时间未查看的后台编辑器。点击页签即可重新打开。</p></div>
    <input className="personal-page-switch" type="checkbox" role="switch" id={`${preferenceId}-sleep`} aria-describedby={`${preferenceId}-sleep-hint`} checked={draft?.sleepInactiveTabs!==false} onChange={event=>edit({sleepInactiveTabs:event.target.checked})}/>
   </div>
   <p className="personal-page-field-hint">更改语言后，请刷新页面或重新打开文档。</p>
  </fieldset>
 </form>
 const content={account,activity,general,skills:<div className="personal-page-skills">{typeof skills==='function'?skills(skillsGuard):skills}</div>}
 const operationStatus=operation==='load'?'正在读取个人偏好…':operation==='save'?'正在保存…':!draft?'个人偏好读取失败，请重新读取':dirty?'有未保存的更改':saved?'个人偏好已保存':'所有更改已保存'
 const tabKeys=['account','activity','general','skills'] as const
 function selectTab(tab:string){setLocalTab(tab);onTabChange?.(tab)}
 function navigateTab(event:KeyboardEvent<HTMLButtonElement>,tab:string){
  const index=tabKeys.indexOf(tab as typeof tabKeys[number])
  const target=event.key==='ArrowRight'?tabKeys[(index+1)%tabKeys.length]:event.key==='ArrowLeft'?tabKeys[(index+tabKeys.length-1)%tabKeys.length]:event.key==='Home'?tabKeys[0]:event.key==='End'?tabKeys[tabKeys.length-1]:null
  if(!target)return
  event.preventDefault();selectTab(target);document.getElementById(`${preferenceId}-tab-${target}`)?.focus()
 }
 return <section className="personal-settings-page" aria-label="个人设置">
  <div className="personal-page-tabs" role="tablist" aria-label="个人设置分类">{tabKeys.map(tab=><button type="button" role="tab" key={tab} id={`${preferenceId}-tab-${tab}`} aria-controls={`${preferenceId}-panel-${tab}`} aria-selected={selectedTab===tab} tabIndex={selectedTab===tab?0:-1} onClick={()=>selectTab(tab)} onKeyDown={event=>navigateTab(event,tab)}>{tabTitles[tab][0]}</button>)}</div>
  <div ref={contentRef} className="personal-page-content">{tabKeys.map(tab=><div key={tab} role="tabpanel" id={`${preferenceId}-panel-${tab}`} aria-labelledby={`${preferenceId}-tab-${tab}`} hidden={selectedTab!==tab} className="personal-page-category">{visitedTabs.current.has(tab)&&<>
   <header className="personal-page-heading"><div><h2>{tabTitles[tab][0]}</h2><p>{tabTitles[tab][1]}</p></div>{tab==='general'&&<div className="personal-page-preference-actions"><button type="button" disabled={busy} onClick={()=>void refresh()}>重新读取</button><button type="button" disabled={busy||!dirty} onClick={revert}>撤销更改</button><button type="button" className="is-primary" aria-busy={operation==='save'} disabled={busy||!dirty} onClick={()=>void commit()}>保存个人偏好</button></div>}</header>
   {(tab==='general'||dirty)&&<div className={`personal-page-save-state${dirty?' is-dirty':''}`}
    data-operation={tab==='general' ? operation : undefined}
    data-load-failed={tab==='general' && !draft && operation!=='load'}
    role="status" aria-live="polite">{tab==='general'?operationStatus:'通用偏好有未保存的更改，请返回通用偏好保存。'}</div>}
   {tab==='general'&&error&&<div className="personal-page-notice is-error" role="alert">{error}</div>}{tab==='general'&&saved&&<div className="personal-page-notice is-success" role="status">个人偏好已保存</div>}
   {content[tab]}
  </>}</div>)}</div>
 </section>
}
