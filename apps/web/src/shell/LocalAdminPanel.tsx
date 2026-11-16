import React,{useEffect,useRef,useState} from 'react'
import {createLocalAdminClient,type LocalAdminClient,type LocalManagedUser,type PasswordAction} from './local-admin-client'
type Operation={kind:'create';username:string;displayName:string}|{kind:'activate'|'reset'|'disable'|'enable';user:LocalManagedUser}
const labels={activate:'重新发放激活码',reset:'重置密码',disable:'禁用账号',enable:'启用账号',create:'创建账号'}
export function LocalAdminPanel({currentUserId,onSessionRotated,onClose,client=createLocalAdminClient()}:{currentUserId:string;onSessionRotated:()=>void;onClose:()=>void;client?:LocalAdminClient}){
 const api=useRef(client).current
 const [users,setUsers]=useState<LocalManagedUser[]>([]),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[operation,setOperation]=useState<Operation|null>(null),[action,setAction]=useState<PasswordAction|null>(null)
 const locked=useRef(false),alive=useRef(true)
 async function load(after?:string){const page=await api.list(after);if(alive.current){setUsers(old=>after?[...old,...page.users]:page.users);setCursor(page.nextCursor)}}
 async function refresh(after?:string){if(locked.current)return;locked.current=true;setBusy(true);setError('');try{await load(after)}catch(e){setUsers([]);setCursor(null);setError((e as Error).message)}finally{locked.current=false;if(alive.current)setBusy(false)}}
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false}},[])
 function choose(value:Operation){setAction(null);setError('');setOperation(value)}
 return <section className="set-pane" aria-label="用户管理"><h3 className="set-pane-title">用户管理</h3><p className="set-pane-desc">仅配置管理员可用。服务端校验权限；每次修改需要重新验证密码。角色编辑尚未接入。</p>
 <button className="set-btn" disabled={busy} onClick={onClose}>关闭用户管理</button>
 {error&&<p role="alert">{error}</p>}
 {action&&<div className="set-field"><p>一次性{action.purpose==='activate'?'激活':'重置'}码，仅本次展示。请通过已核实的安全渠道交给本人；不会自动发送。</p><label>一次性码<input aria-label="一次性码" readOnly value={action.token} autoComplete="off"/></label><p>到期：{action.expiresAt}</p><button className="set-btn" onClick={()=>setAction(null)}>已记录，隐藏</button></div>}
 {!operation&&<form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);choose({kind:'create',username:String(data.get('username')||''),displayName:String(data.get('displayName')||'')});e.currentTarget.reset()}}><div className="set-field"><label>新用户名<input name="username" maxLength={256} required disabled={busy}/></label><label>显示名称<input name="displayName" maxLength={200} disabled={busy}/></label><button className="set-btn primary" disabled={busy}>创建账号</button></div></form>}
 {operation&&<form aria-label="确认用户操作" onSubmit={async e=>{
  e.preventDefault();if(locked.current)return;const form=e.currentTarget;const password=String(new FormData(form).get('password')||'');form.reset();locked.current=true;setBusy(true);setError('');setAction(null)
  try{try{await api.reauthenticate(password)}finally{onSessionRotated()}
   const result=operation.kind==='create'?await api.create(operation.username,operation.displayName):operation.kind==='activate'||operation.kind==='reset'?await api.issue(operation.user.id,operation.kind):await api.setStatus(operation.user.id,operation.kind==='disable'?'disabled':'active')
   if(!alive.current)return
   if('action' in result)setAction(result.action)
   setOperation(null)
   try{await load()}catch{setUsers([]);setCursor(null);setError('修改已成功，但列表刷新失败。请刷新列表，不要重复提交。')}
  }catch(e){if(alive.current){setOperation(null);setError((e as Error).message+'。请先刷新状态再决定是否重试。')}}finally{locked.current=false;if(alive.current)setBusy(false)}
 }}><h4>{labels[operation.kind]}：{operation.kind==='create'?operation.username:operation.user.username}</h4><p>{operation.kind==='reset'?'此操作立即阻止旧密码登录、撤销目标会话；旧激活或重置码也会失效。':operation.kind==='disable'?'此操作将撤销目标用户会话。':operation.kind==='activate'?'原一次性码将失效。':'请核对目标账号后确认。'}</p><label>管理员当前密码<input name="password" aria-label="管理员当前密码" type="password" autoComplete="current-password" required disabled={busy}/></label><button className="set-btn primary" disabled={busy}>验证并确认</button><button type="button" className="set-btn" disabled={busy} onClick={()=>setOperation(null)}>取消</button></form>}
 <button className="set-btn" disabled={busy||!!operation} onClick={()=>void refresh()}>刷新列表</button>
 <ul>{users.map(u=><li key={u.id}><strong>{u.displayName||u.username}</strong> ({u.username}) · {u.status}{u.requiresPasswordReset?' · 需重置密码':''}<p>{u.roles.join(' / ')}</p>{u.id!==currentUserId&&<>{u.status==='pending'&&<button disabled={busy||!!operation} onClick={()=>choose({kind:'activate',user:u})}>重新发放激活码</button>}{u.status==='active'&&<button disabled={busy||!!operation} onClick={()=>choose({kind:'reset',user:u})}>重置密码</button>}<button disabled={busy||!!operation} onClick={()=>choose({kind:u.status==='disabled'?'enable':'disable',user:u})}>{u.status==='disabled'?'启用账号':'禁用账号'}</button></>}</li>)}</ul>
 {cursor&&<button disabled={busy||!!operation} onClick={()=>void refresh(cursor)}>下一页</button>}
 </section>
}
