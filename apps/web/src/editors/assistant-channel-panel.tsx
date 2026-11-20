import {useEffect,useState} from 'react'
import {AssistantAvatar} from '@genoffice/ui'
import type {AssistantChannelClient} from '../../../../packages/browser-host/src/assistant-channel'
import './assistant-channel-panel.css'

const labels={
 zh:{office:'Office 助手',add:'添加 Agent',title:'Agent 协作',invite:'生成邀请',copy:'复制邀请',hide:'隐藏邀请',expires:'有效至',approval:'待批准申请',approve:'批准',reject:'拒绝',members:'频道成员',online:'在线',previewActive:'预览连接活跃',offline:'离线',remove:'移除',pause:'暂停协作',resume:'恢复协作',refresh:'刷新',recipient:'接收 Agent',instruction:'协作任务',send:'发送任务',tasks:'协作任务',cancel:'取消任务',error:'协作操作未完成，请刷新后重试。',close:'收起',noMembers:'暂无已授权 Agent',noTasks:'暂无协作任务',copied:'已复制',states:{queued:'排队中',running:'执行中',waiting_peer:'等待协作方',cancel_requested:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消',unknown_outcome:'结果待核对'}},
 en:{office:'Office assistant',add:'Add Agent',title:'Agent collaboration',invite:'Create invitation',copy:'Copy invitation',hide:'Hide invitation',expires:'Expires',approval:'Pending applications',approve:'Approve',reject:'Reject',members:'Channel members',online:'Online',previewActive:'Preview connected',offline:'Offline',remove:'Remove',pause:'Pause collaboration',resume:'Resume collaboration',refresh:'Refresh',recipient:'Recipient Agent',instruction:'Collaboration task',send:'Send task',tasks:'Collaboration tasks',cancel:'Cancel task',error:'Collaboration action did not finish. Refresh and retry.',close:'Collapse',noMembers:'No authorized Agents',noTasks:'No collaboration tasks',copied:'Copied',states:{queued:'Queued',running:'Running',waiting_peer:'Waiting for peer',cancel_requested:'Cancelling',succeeded:'Succeeded',failed:'Failed',cancelled:'Cancelled',unknown_outcome:'Outcome needs review'}},
} as const

/** Optional controls own only their own draft; the document assistant input is untouched. */
export function AssistantChannelPanel({client,lang,mode='all'}: {client:AssistantChannelClient;lang?:'zh'|'en';mode?:'all'|'members'|'tasks'}) {
 const text=labels[lang ?? (typeof document!=='undefined' && document.documentElement.lang.startsWith('en')?'en':'zh')]
 const [snapshot,setSnapshot]=useState(()=>client.snapshot()),[open,setOpen]=useState(()=>!!client.snapshot())
 const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[invitation,setInvitation]=useState<{inviteToken:string;expiresAt:string}|null>(null)
 const [copied,setCopied]=useState(false),[recipient,setRecipient]=useState(''),[instruction,setInstruction]=useState('')
 useEffect(()=>client.subscribe(()=>setSnapshot(client.snapshot())),[client])
 useEffect(()=>{if(!invitation)return;const timer=setTimeout(()=>setInvitation(null),Math.max(0,new Date(invitation.expiresAt).getTime()-Date.now()));return()=>clearTimeout(timer)},[invitation])
 const perform=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setFailed(false);try{await action();setSnapshot(client.snapshot())}catch{setFailed(true)}finally{setBusy(false)}}
 const active=snapshot?.members.filter(member=>!member.revoked) ?? []
 const selected=active.some(member=>member.membershipId===recipient)?recipient:active[0]?.membershipId ?? ''
 const taskList=<div><strong>{text.tasks}</strong>{snapshot?.tasks.length?snapshot.tasks.map(task=><div className="assistant-channel-item" key={task.taskId}><AssistantAvatar id={snapshot.members.find(member=>member.membershipId===task.to)?.kind} name={task.to==='office'?text.office:snapshot.members.find(member=>member.membershipId===task.to)?.displayName??'Agent'} origin={task.to==='office'?'office':'external'}/><span dir="auto">{task.instruction}</span><small>{text.states[task.state]}</small>{['queued','running','waiting_peer'].includes(task.state)&&<button type="button" disabled={busy} onClick={()=>void perform(()=>client.cancel(task.taskId))}>{text.cancel}</button>}{task.summary&&<p className="assistant-channel-result" dir="auto">{task.summary}</p>}</div>):<p>{text.noTasks}</p>}</div>
 if(mode==='tasks')return <section className="assistant-channel-panel" aria-label={text.tasks}>{(failed||client.error())&&<p role="alert">{text.error}</p>}<button type="button" disabled={busy} onClick={()=>void perform(()=>client.refresh())}>{text.refresh}</button>{taskList}</section>
 if(!open)return <div><button className="assistant-channel-add" type="button" disabled={busy} onClick={()=>void perform(async()=>{await client.start();setOpen(true)})}>{text.add}</button>{(failed||client.error())&&<p role="alert">{text.error}</p>}</div>
 return <section className="assistant-channel-panel" aria-label={text.title}>
  <div className="assistant-channel-toolbar"><strong>{text.title}</strong><button type="button" onClick={()=>{setInvitation(null);setOpen(false)}}>{text.close}</button></div>
  {(failed||client.error())&&<p role="alert">{text.error}</p>}
  <div className="assistant-channel-toolbar">
   <button type="button" disabled={busy} onClick={()=>void perform(async()=>{setCopied(false);setInvitation(await client.invite())})}>{text.invite}</button>
   <button type="button" disabled={busy} onClick={()=>void perform(()=>client.pause(!snapshot?.paused))}>{snapshot?.paused?text.resume:text.pause}</button>
   <button type="button" disabled={busy} onClick={()=>void perform(()=>client.refresh())}>{text.refresh}</button>
  </div>
  {invitation&&<div className="assistant-channel-invitation"><code>{invitation.inviteToken}</code><small>{text.expires} {new Date(invitation.expiresAt).toLocaleTimeString()}</small><button type="button" onClick={()=>void perform(async()=>{await navigator.clipboard.writeText(invitation.inviteToken);setCopied(true)})}>{copied?text.copied:text.copy}</button><button type="button" onClick={()=>setInvitation(null)}>{text.hide}</button></div>}
  {!!snapshot?.applications.length&&<div><strong>{text.approval}</strong>{snapshot.applications.map(application=><div className="assistant-channel-item" key={application.applicationId}><span dir="auto">{application.displayName} · {application.kind}</span><small>{application.applicationId}</small><button type="button" disabled={busy} onClick={()=>void perform(()=>client.approve(application.applicationId,true))}>{text.approve}</button><button type="button" disabled={busy} onClick={()=>void perform(()=>client.approve(application.applicationId,false))}>{text.reject}</button></div>)}</div>}
  <div><strong>{text.members}</strong>{active.length?active.map(member=><div className="assistant-channel-item" key={member.membershipId}><AssistantAvatar id={member.kind} name={member.displayName} origin="external"/><span dir="auto">{member.displayName} · {member.kind}</span><small>{member.online?text.online:member.previewActive?text.previewActive:text.offline}</small><button type="button" disabled={busy} onClick={()=>void perform(()=>client.remove(member.membershipId))}>{text.remove}</button></div>):<p>{text.noMembers}</p>}</div>
  {mode==='all'&&!!active.length&&<form onSubmit={event=>{event.preventDefault();if(selected&&instruction.trim())void perform(async()=>{await client.send(selected,instruction);setInstruction('')})}}>
   <label>{text.recipient}<select value={selected} disabled={busy} onChange={event=>setRecipient(event.target.value)}>{active.map(member=><option key={member.membershipId} value={member.membershipId}>{member.displayName}</option>)}</select></label>
   <label>{text.instruction}<textarea value={instruction} maxLength={16000} disabled={busy} onChange={event=>setInstruction(event.target.value)}/></label>
   <button type="submit" disabled={busy||!!snapshot?.paused||!instruction.trim()}>{text.send}</button>
  </form>}
  {mode==='all'&&taskList}
 </section>
}
