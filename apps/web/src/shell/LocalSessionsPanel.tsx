import {Alert, Button} from 'antd'
import React,{useCallback,useEffect,useRef,useState} from 'react'
import {localSessionsClient,type LocalSessionsClient,type LocalSession} from './local-sessions-client'
/** Actual server sessions, not guessed device identities. No credential values are displayed. */
export function LocalSessionsPanel({client=localSessionsClient,onCurrentRevoked,onCloseGuardChange}:{client?:LocalSessionsClient;onCurrentRevoked:()=>void;onCloseGuardChange?:(guard:(()=>boolean)|null)=>void}){
 const [rows,setRows]=useState<LocalSession[]>([]),[pending,setPending]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[confirm,setConfirm]=useState<LocalSession|'others'|null>(null)
 const [unknown,setUnknown]=useState(false)
 const revoking=useRef(false),closeState=useRef({unknown:false,confirm:false})
 closeState.current={unknown,confirm:!!confirm}
 const canClose=useCallback(()=>{if(revoking.current)return false;if(closeState.current.unknown)return window.confirm('会话撤销结果尚未确认，请先刷新核对。仍要关闭？');return !closeState.current.confirm||window.confirm('会话撤销尚未确认，是否取消操作并关闭？')},[])
 useEffect(()=>{onCloseGuardChange?.(canClose);return()=>onCloseGuardChange?.(null)},[canClose,onCloseGuardChange])
 const busy=useRef(false),alive=useRef(true)
 async function refresh(){if(busy.current)return;busy.current=true;setPending(true);setError('');setMessage('');setConfirm(null);try{const result=await client.list();if(alive.current){setRows(result);setUnknown(false)}}catch{if(alive.current)setError('无法读取登录会话，请重新加载并确认登录状态。')}finally{busy.current=false;if(alive.current)setPending(false)}}
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false}},[client])
 async function revoke(){if(busy.current||!confirm)return;const target=confirm;busy.current=true;revoking.current=true;setPending(true);setError('');setMessage('');setConfirm(null)
  try{if(target==='others')await client.revokeOthers();else await client.revoke(target.id);if(target!=='others'&&target.current){onCurrentRevoked();return}if(alive.current){setRows(old=>old.filter(row=>target==='others'?row.current:row.id!==target.id));setMessage(target==='others'?'其他会话已撤销，当前会话保持登录。':'所选会话已撤销。')}}catch{if(alive.current){setUnknown(true);setError('撤销结果未确认。请先刷新会话列表核对，不要重复提交。')}}finally{revoking.current=false;busy.current=false;if(alive.current)setPending(false)}
 }
 return <section className="personal-account-section" aria-labelledby="local-sessions-title"><h4 id="local-sessions-title" className="personal-account-section-title">登录会话</h4><p className="personal-account-section-desc">仅显示当前账号的有效会话。时间来自服务器；不推测设备或位置。撤销当前会话将返回登录页。</p><div className="set-btn-row personal-account-toolbar"><Button autoInsertSpace={false} htmlType="button"  disabled={pending} onClick={()=>void refresh()}>刷新会话列表</Button><Button autoInsertSpace={false} htmlType="button"  disabled={pending||unknown||!!confirm||!rows.some(row=>!row.current)} onClick={()=>{setMessage('');setError('');setConfirm('others')}}>撤销所有其他会话</Button></div>
 {error&&<Alert type="error" showIcon title={error}/>}{message&&<Alert type="success" showIcon role="status" title={message}/>}
 {confirm&&<div className="personal-account-confirm" role="group" aria-label="确认撤销会话"><p>{confirm==='others'?'确定撤销所有其他会话？当前会话将保持登录，未来新登录不受影响。':confirm.current?'确定撤销当前会话并退出登录？':'确定撤销所选会话？该会话将无法继续访问。'}</p><Button autoInsertSpace={false} htmlType="button" danger disabled={pending} onClick={()=>void revoke()}>确认撤销</Button><Button autoInsertSpace={false} htmlType="button"  disabled={pending} onClick={()=>setConfirm(null)}>取消</Button></div>}
 <ul role="list" className="personal-session-list">{rows.map(row=><li className="personal-session-row" key={row.id} data-session-id={row.id}><div className="personal-session-content"><strong className="personal-session-title">{row.current?'当前浏览器会话':'其他登录会话'}</strong><dl className="personal-session-times"><div><dt>创建</dt><dd><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time></dd></div><div><dt>最近使用</dt><dd><time dateTime={row.lastSeenAt}>{new Date(row.lastSeenAt).toLocaleString()}</time></dd></div><div><dt>到期</dt><dd><time dateTime={row.expiresAt}>{new Date(row.expiresAt).toLocaleString()}</time></dd></div></dl></div><Button autoInsertSpace={false} htmlType="button"  disabled={pending||unknown||!!confirm} onClick={()=>{setMessage('');setError('');setConfirm(row)}}>{row.current?'撤销当前会话':'撤销此会话'}</Button></li>)}</ul>
 </section>
}
