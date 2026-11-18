import React,{useRef,useState} from 'react'
import {Alert,Button,Form,Input,Select} from 'antd'
import {createLocalAdminClient,type LocalAdminClient} from './local-admin-client'
/** Mount only on the signed-out screen. Codes are typed, never read from URLs. */
export function PasswordActionForm({onClose,client=createLocalAdminClient()}:{onClose:()=>void;client?:LocalAdminClient}){
 const api=useRef(client).current,lock=useRef(false)
 const [pending,setPending]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('')
 const [purpose,setPurpose]=useState<'activate'|'reset'>('activate'),[secretGeneration,setSecretGeneration]=useState(0)
 return <section className="set-pane" aria-label="激活或重置密码"><h3 className="set-pane-title">激活或重置密码</h3><p className="set-pane-desc">请先退出登录，并输入管理员安全交付的一次性码。不要把码放入网址。</p>{done?<Alert type="success" showIcon role="status" title="密码已设置。请返回登录；此操作不会自动登录。"/>:<form onSubmit={async e=>{
  e.preventDefault();if(lock.current)return;const form=e.currentTarget,data=new FormData(form),password=String(data.get('password')||'')
  if(password!==data.get('confirm')){setError('两次密码不一致');return}
  lock.current=true;setPending(true);setError('')
  const token=String(data.get('token')||'').trim(),selectedPurpose=purpose;form.reset();setPurpose('activate');setSecretGeneration(value=>value+1)
  try{await api.redeem(token,selectedPurpose,password);setDone(true)}catch(e){setError((e as Error).message+'。一次性码可能已失效；不会自动重试。')}finally{lock.current=false;setPending(false)}
 }}>
  <Form component={false} layout="vertical" disabled={pending}>
   <Form.Item label="用途" htmlFor="password-action-purpose"><Select id="password-action-purpose" aria-label="用途" value={purpose} disabled={pending} onChange={setPurpose} options={[{value:'activate',label:'激活账号'},{value:'reset',label:'重置密码'}]}/></Form.Item>
   <Form.Item label="一次性码" htmlFor="password-action-token"><Input key={`${secretGeneration}-token`} id="password-action-token" name="token" aria-label="一次性码" autoComplete="off" required pattern="[A-Za-z0-9_-]{43}" disabled={pending}/></Form.Item>
   <Form.Item label="新密码" htmlFor="password-action-password"><Input.Password visibilityToggle={false} key={`${secretGeneration}-password`} id="password-action-password" name="password" autoComplete="new-password" required maxLength={1024} disabled={pending}/></Form.Item>
   <Form.Item label="再次输入密码" htmlFor="password-action-confirm"><Input.Password visibilityToggle={false} key={`${secretGeneration}-confirm`} id="password-action-confirm" name="confirm" autoComplete="new-password" required maxLength={1024} disabled={pending}/></Form.Item>
   <Button autoInsertSpace={false} type="primary" htmlType="submit" loading={pending} disabled={pending}>{pending?'正在提交…':'设置密码'}</Button>
  </Form>
 </form>}{error&&<Alert type="error" showIcon title={error}/>}<div className="set-btn-row"><Button autoInsertSpace={false} htmlType="button" disabled={pending} onClick={onClose}>返回登录</Button></div></section>
}
