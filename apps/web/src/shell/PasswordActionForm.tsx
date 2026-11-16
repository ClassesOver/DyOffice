import React,{useRef,useState} from 'react'
import {createLocalAdminClient,type LocalAdminClient} from './local-admin-client'
/** Mount only on the signed-out screen. Codes are typed, never read from URLs. */
export function PasswordActionForm({onClose,client=createLocalAdminClient()}:{onClose:()=>void;client?:LocalAdminClient}){
 const api=useRef(client).current,lock=useRef(false)
 const [pending,setPending]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('')
 return <section className="set-pane" aria-label="激活或重置密码"><h3 className="set-pane-title">激活或重置密码</h3><p className="set-pane-desc">请先退出登录，并输入管理员安全交付的一次性码。不要把码放入网址。</p>{done?<p role="status">密码已设置。请返回登录；此操作不会自动登录。</p>:<form onSubmit={async e=>{
  e.preventDefault();if(lock.current)return;const form=e.currentTarget,data=new FormData(form),password=String(data.get('password')||'')
  if(password!==data.get('confirm')){setError('两次密码不一致');return}
  lock.current=true;setPending(true);setError('')
  const token=String(data.get('token')||'').trim(),purpose=String(data.get('purpose')) as 'activate'|'reset';form.reset()
  try{await api.redeem(token,purpose,password);setDone(true)}catch(e){setError((e as Error).message+'。一次性码可能已失效；不会自动重试。')}finally{lock.current=false;setPending(false)}
 }}><label className="set-field">用途<select className="set-input" aria-label="用途" name="purpose" disabled={pending}><option value="activate">激活账号</option><option value="reset">重置密码</option></select></label><label className="set-field">一次性码<input className="set-input" name="token" aria-label="一次性码" autoComplete="off" required pattern="[A-Za-z0-9_-]{43}" disabled={pending}/></label><label className="set-field">新密码<input className="set-input" name="password" type="password" autoComplete="new-password" required maxLength={1024} disabled={pending}/></label><label className="set-field">再次输入密码<input className="set-input" name="confirm" type="password" autoComplete="new-password" required maxLength={1024} disabled={pending}/></label><button className="set-btn primary" disabled={pending}>{pending?'正在提交…':'设置密码'}</button></form>}{error&&<p role="alert">{error}</p>}<div className="set-btn-row"><button className="set-btn" disabled={pending} onClick={onClose}>返回登录</button></div></section>
}
