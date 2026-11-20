import {NativeSettingsPager as SettingsListPager} from './NativeSettingsPager'
import React,{useCallback,useEffect,useRef,useState} from 'react'
import {localSessionsClient,type LocalSessionsClient,type LocalSession} from './local-sessions-client'
/** Actual server sessions, not guessed device identities. No credential values are displayed. */
export function LocalSessionsPanel({client=localSessionsClient,refreshVersion=0,onCurrentRevoked,onCloseGuardChange}:{client?:LocalSessionsClient;refreshVersion?:number;onCurrentRevoked:()=>void;onCloseGuardChange?:(guard:(()=>boolean)|null)=>void}){
 const [rows,setRows]=useState<LocalSession[]>([]),[pending,setPending]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[confirm,setConfirm]=useState<LocalSession|'others'|null>(null)
 const [unknown,setUnknown]=useState(false),[revoked,setRevoked]=useState(false)
 const [page,setPage]=useState(0),[nextCursor,setNextCursor]=useState<string|null>(null)
 const pageSize=5,cursors=useRef<(string|undefined)[]>([undefined])
 const ended=useRef(false)
 const revoking=useRef(false),closeState=useRef({unknown:false,confirm:false})
 closeState.current={unknown,confirm:!!confirm}
 const canClose=useCallback(()=>{if(ended.current)return true;if(revoking.current)return false;if(closeState.current.unknown)return window.confirm('会话撤销结果尚未确认，请先刷新核对。仍要关闭？');return !closeState.current.confirm||window.confirm('会话撤销尚未确认，是否取消操作并关闭？')},[])
 useEffect(()=>{onCloseGuardChange?.(canClose);return()=>onCloseGuardChange?.(null)},[canClose,onCloseGuardChange])
 const busy=useRef(false),alive=useRef(true)
 useEffect(()=>{const prevent=(event:BeforeUnloadEvent)=>{if(busy.current||closeState.current.unknown){event.preventDefault();event.returnValue=''}};window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent)},[])
 async function readPage(target=0){
  const result=await client.listPage({limit:pageSize,after:cursors.current[target]})
  if(!alive.current)return
  cursors.current=cursors.current.slice(0,target+1)
  if(result.nextCursor)cursors.current[target+1]=result.nextCursor
  setRows(result.sessions);setPage(target);setNextCursor(result.nextCursor)
 }
 async function refresh(target=0){if(busy.current||ended.current)return;busy.current=true;setPending(true);setError('');setMessage('');setConfirm(null);try{
  // A partial page cannot reconcile an uncertain revoke. Only explicit refresh
  // runs the legacy full read before returning to ordinary paged browsing.
  if(unknown)await client.list()
  await readPage(target);if(alive.current)setUnknown(false)
 }catch{if(alive.current)setError('无法读取登录会话，请重新加载并确认登录状态。')}finally{busy.current=false;if(alive.current)setPending(false)}}
 function changePage(target:number){if(unknown||confirm||busy.current||ended.current)return;void refresh(target)}

 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false}},[client])
 const refreshedVersion=useRef(refreshVersion),latestRefreshVersion=useRef(refreshVersion)
 latestRefreshVersion.current=refreshVersion
 // Password rotation must refresh sessions without discarding a pending revocation or its close guard.
 useEffect(()=>{if(refreshedVersion.current===refreshVersion||busy.current||ended.current)return;refreshedVersion.current=refreshVersion;void refresh()},[refreshVersion,pending])
 async function revoke(){if(busy.current||ended.current||!confirm)return;const target=confirm;busy.current=true;revoking.current=true;setPending(true);setError('');setMessage('');setConfirm(null)
  try{if(target==='others')await client.revokeOthers();else await client.revoke(target.id);if(target!=='others'&&target.current){ended.current=true;busy.current=false;revoking.current=false;if(alive.current){setRevoked(true);setRows([]);setMessage('当前会话已撤销。请重新加载并核对登录状态。')}onCurrentRevoked();return}if(alive.current){setRows(old=>old.filter(row=>target==='others'?row.current:row.id!==target.id));setMessage(target==='others'?'其他会话已撤销，当前会话保持登录。':'所选会话已撤销。');try{const version=latestRefreshVersion.current;await readPage(0);refreshedVersion.current=version}catch{if(alive.current)setError('会话已撤销，但列表刷新失败。请刷新列表，不要重复提交。')}}}catch{if(alive.current){setUnknown(true);setError('撤销结果未确认。请先刷新会话列表核对，不要重复提交。')}}finally{revoking.current=false;busy.current=false;if(alive.current)setPending(false)}
 }
 return <section className="personal-account-section" aria-labelledby="local-sessions-title"><h4 id="local-sessions-title" className="personal-account-section-title">登录会话</h4><p className="personal-account-section-desc">仅显示当前账号的有效会话，时间以服务器为准，不含设备或位置。撤销当前会话后，需重新加载并核对登录状态。</p><div className="set-btn-row personal-account-toolbar"><button type="button"  disabled={pending||revoked} onClick={()=>void refresh()}>刷新会话列表</button><button type="button"  disabled={pending||revoked||unknown||!!confirm||(!rows.some(row=>!row.current)&&!nextCursor&&page===0)} onClick={()=>{setMessage('');setError('');setConfirm('others')}}>撤销所有其他会话</button></div>
 {error&&<div className="personal-page-notice is-error" role="alert">{error}</div>}{message&&<div className="personal-page-notice is-success" role="status">{message}</div>}
 {confirm&&<div className="personal-account-confirm" role="group" aria-label="确认撤销会话"><p>{confirm==='others'?'确定撤销所有其他会话？当前会话将保持登录，未来新登录不受影响。':confirm.current?'确定撤销当前会话？撤销后需重新加载并核对登录状态。':'确定撤销所选会话？该会话将无法继续访问。'}</p><button type="button" data-danger="true" disabled={pending||revoked} onClick={()=>void revoke()}>确认撤销</button><button type="button"  disabled={pending||revoked} onClick={()=>setConfirm(null)}>取消</button></div>}
 <div className="settings-list-scroll-region personal-sessions-scroll" role="region" aria-label="当前有效会话列表" tabIndex={0}><ul role="list" className="personal-session-list">{rows.map(row=><li className="personal-session-row" key={row.id} data-session-id={row.id}><div className="personal-session-content"><strong className="personal-session-title">{row.current?'当前浏览器会话':'其他登录会话'}</strong><dl className="personal-session-times"><div><dt>创建</dt><dd><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time></dd></div><div><dt>最近使用</dt><dd><time dateTime={row.lastSeenAt}>{new Date(row.lastSeenAt).toLocaleString()}</time></dd></div><div><dt>到期</dt><dd><time dateTime={row.expiresAt}>{new Date(row.expiresAt).toLocaleString()}</time></dd></div></dl></div><button type="button"  disabled={pending||revoked||unknown||!!confirm} onClick={()=>{setMessage('');setError('');setConfirm(row)}}>{row.current?'撤销当前会话':'撤销此会话'}</button></li>)}</ul></div><div className="personal-account-list-footer"><span>登录会话 · 每页 5 条</span><SettingsListPager page={page} pageSize={pageSize} hasPrevious={page>0} hasNext={nextCursor!==null} onPageChange={changePage} label="登录会话" disabled={pending||revoked||unknown||!!confirm}/></div>
 </section>
}
