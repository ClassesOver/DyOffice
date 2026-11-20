import React,{useCallback,useEffect,useRef,useState} from 'react'
import './personal-account.css'
/** Local-account slot within the original SettingsModal; no credentials are persisted. */
export function LocalPasswordForm({changePassword,reload,onCloseGuardChange}:{onCloseGuardChange?:(guard:(()=>boolean)|null)=>void;changePassword:(current:string,next:string)=>Promise<void>;reload:()=>void}){
 const locked=useRef(false)
 const [state,setState]=useState<'idle'|'pending'|'success'|'error'|'unknown'>('idle')
 const [invalidField,setInvalidField]=useState('')
 const [error,setError]=useState(''),[secretGeneration,setSecretGeneration]=useState(0)
 const closeState=useRef({dirty:false,unknown:false})
 closeState.current.unknown=state==='unknown'
 const canClose=useCallback(()=>{if(closeState.current.unknown)return window.confirm('密码修改结果尚未确认。关闭后请重新加载并核对登录状态，不要重复提交。是否关闭？');if(locked.current)return false;return !closeState.current.dirty||window.confirm('密码表单尚未提交，是否清空并关闭？')},[])
 useEffect(()=>{onCloseGuardChange?.(canClose);return()=>onCloseGuardChange?.(null)},[canClose,onCloseGuardChange])
 useEffect(()=>{const prevent=(event:BeforeUnloadEvent)=>{if(locked.current||closeState.current.dirty||closeState.current.unknown){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[])
 async function submit(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(locked.current)return
  const form=event.currentTarget,data=new FormData(form)
  const current=String(data.get('currentPassword')||''),next=String(data.get('newPassword')||''),confirmation=String(data.get('confirmation')||'')
  setState('error');setError('');setInvalidField('')
  function invalid(field:string,message:string){setInvalidField(field);setError(message);(form.elements.namedItem(field) as HTMLInputElement).focus()}
  if(!current){invalid('currentPassword','请输入当前密码。');return}
  if([...next].length<15||new TextEncoder().encode(next).length>1024||!next.trim()){invalid('newPassword','新密码至少 15 个字符，最多 1024 字节，可使用长短语。');return}
  if(next!==confirmation){invalid('confirmation','两次新密码不一致。');return}
  locked.current=true;setState('pending');form.reset();closeState.current.dirty=false;setSecretGeneration(value=>value+1)
  try{await changePassword(current,next);setState('success');locked.current=false}
  catch(cause){
   const status=(cause as {status?:number})?.status
   if(status!==undefined&&status>=400&&status<500&&status!==408){setState('error');locked.current=false;setError(status===401?'当前密码不正确或会话已失效，请核对后重试。':status===429?'请求过于频繁，请稍后再试。':status===400?'新密码不符合服务器策略，请使用未泄露的长短语。':'请求被拒绝，请重新加载并确认登录状态。')}
   else{setState('unknown');setError('无法确认密码是否已修改。请重新加载并检查登录状态；不要重复提交。')}
  }
 }
 return <section className="personal-account-section personal-account-password" aria-labelledby="local-password-title"><h4 id="local-password-title" className="personal-account-section-title">修改密码</h4><p className="personal-account-section-desc">至少 15 个字符，可使用长短语。修改成功后当前会话会更新，其他旧会话将失效。</p><form onSubmit={submit} onReset={()=>{if(locked.current)return;setSecretGeneration(value=>value+1);closeState.current.dirty=false;setState('idle');setError('');setInvalidField('')}} onChange={event=>{const data=new FormData(event.currentTarget);closeState.current.dirty=[...data.values()].some(value=>String(value).length>0);if(state==='success'){setState('idle')}if(invalidField){setInvalidField('');setError('');setState('idle')}}}>
  <fieldset disabled={state==='pending'||state==='unknown'} className="personal-account-fields">
   <div className="set-field"><div className="set-field-text"><label className="set-field-label" htmlFor="local-current-password">当前密码</label></div><input type="password" key={`${secretGeneration}-current`} disabled={state==='pending'||state==='unknown'} id="local-current-password"  name="currentPassword" aria-invalid={invalidField==='currentPassword'} aria-describedby={invalidField==='currentPassword'?'local-password-error':undefined}  autoComplete="current-password" required maxLength={1024}/></div>
   <div className="set-field"><div className="set-field-text"><label className="set-field-label" htmlFor="local-new-password">新密码</label></div><input type="password" key={`${secretGeneration}-new`} disabled={state==='pending'||state==='unknown'} id="local-new-password"  name="newPassword" aria-invalid={invalidField==='newPassword'} aria-describedby={invalidField==='newPassword'?'local-password-error':undefined}  autoComplete="new-password" required maxLength={1024}/></div>
   <div className="set-field"><div className="set-field-text"><label className="set-field-label" htmlFor="local-confirm-password">确认新密码</label></div><input type="password" key={`${secretGeneration}-confirmation`} disabled={state==='pending'||state==='unknown'} id="local-confirm-password"  name="confirmation" aria-invalid={invalidField==='confirmation'} aria-describedby={invalidField==='confirmation'?'local-password-error':undefined}  autoComplete="new-password" required maxLength={1024}/></div>
   <div className="personal-account-actions"><button className="is-primary" type="submit" aria-busy={state==='pending'} disabled={state==='pending'||state==='unknown'}>{state==='pending'?'正在修改…':'修改密码'}</button><button type="reset" disabled={state==='pending'||state==='unknown'}>清空输入</button></div>
  </fieldset>
  {state==='success'&&<div className="personal-page-notice is-success" role="status">密码已修改。当前会话已更新，其他旧会话已失效。</div>}
  {(state==='error'||state==='unknown')&&<div id="local-password-error" className={`personal-page-notice ${state==='unknown'?'is-warning':'is-error'}`} role="alert">{error}</div>}
  {state==='unknown'&&<button type="button"  onClick={reload}>重新加载</button>}
 </form></section>
}
