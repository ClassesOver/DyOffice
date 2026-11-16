import React,{useRef,useState} from 'react'
/** Local-account slot within the original SettingsModal; no credentials are persisted. */
export function LocalPasswordForm({changePassword,reload}:{changePassword:(current:string,next:string)=>Promise<void>;reload:()=>void}){
 const locked=useRef(false)
 const [state,setState]=useState<'idle'|'pending'|'success'|'error'|'unknown'>('idle')
 const [error,setError]=useState('')
 async function submit(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(locked.current)return
  const form=event.currentTarget,data=new FormData(form)
  const current=String(data.get('currentPassword')||''),next=String(data.get('newPassword')||''),confirmation=String(data.get('confirmation')||'')
  setState('error');setError('')
  if(!current){setError('请输入当前密码。');return}
  if(next!==confirmation){setError('两次新密码不一致。');return}
  if([...next].length<15||new TextEncoder().encode(next).length>1024||!next.trim()){setError('新密码至少 15 个字符，最多 1024 字节，可使用长短语。');return}
  locked.current=true;setState('pending');form.reset()
  try{await changePassword(current,next);setState('success');locked.current=false}
  catch(cause){
   const status=(cause as {status?:number})?.status
   if(status!==undefined&&status>=400&&status<500){setState('error');locked.current=false;setError(status===401?'当前密码不正确或会话已失效，请核对后重试。':status===429?'请求过于频繁，请稍后再试。':status===400?'新密码不符合服务器策略，请使用未泄露的长短语。':'请求被拒绝，请重新加载并确认登录状态。')}
   else{setState('unknown');setError('无法确认密码是否已修改。请重新加载并检查登录状态；不要重复提交。')}
  }
 }
 return <section aria-labelledby="local-password-title"><h4 id="local-password-title" className="set-field-label">修改密码</h4><p className="set-pane-desc">至少 15 个字符，可使用长短语。修改成功后当前会话会更新，其他旧会话将失效。</p><form onSubmit={submit}>
  <fieldset disabled={state==='pending'||state==='unknown'} style={{border:0,padding:0,margin:0}}>
   <div className="set-field"><label className="set-field-label" htmlFor="local-current-password">当前密码</label><input id="local-current-password" className="set-input" name="currentPassword" type="password" autoComplete="current-password" required maxLength={1024}/></div>
   <div className="set-field"><label className="set-field-label" htmlFor="local-new-password">新密码</label><input id="local-new-password" className="set-input" name="newPassword" type="password" autoComplete="new-password" required maxLength={1024}/></div>
   <div className="set-field"><label className="set-field-label" htmlFor="local-confirm-password">确认新密码</label><input id="local-confirm-password" className="set-input" name="confirmation" type="password" autoComplete="new-password" required maxLength={1024}/></div>
   <button className="set-btn" type="submit">{state==='pending'?'正在修改…':'修改密码'}</button>
  </fieldset>
  {state==='success'&&<p role="status">密码已修改。当前会话已更新，其他旧会话已失效。</p>}
  {(state==='error'||state==='unknown')&&<p role="alert">{error}</p>}
  {state==='unknown'&&<button type="button" className="set-btn" onClick={reload}>重新加载</button>}
 </form></section>
}
