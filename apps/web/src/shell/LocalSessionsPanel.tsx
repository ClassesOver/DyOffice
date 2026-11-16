import React,{useEffect,useRef,useState} from 'react'
import {localSessionsClient,type LocalSessionsClient,type LocalSession} from './local-sessions-client'
/** Actual server sessions, not guessed device identities. No credential values are displayed. */
export function LocalSessionsPanel({client=localSessionsClient,onCurrentRevoked}:{client?:LocalSessionsClient;onCurrentRevoked:()=>void}){
 const [rows,setRows]=useState<LocalSession[]>([]),[pending,setPending]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[confirm,setConfirm]=useState<LocalSession|'others'|null>(null)
 const busy=useRef(false),alive=useRef(true)
 async function refresh(){if(busy.current)return;busy.current=true;setPending(true);setError('');setMessage('');setConfirm(null);try{const result=await client.list();if(alive.current)setRows(result)}catch{if(alive.current)setError('无法读取登录会话，请重新加载并确认登录状态。')}finally{busy.current=false;if(alive.current)setPending(false)}}
 useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false}},[client])
 async function revoke(){if(busy.current||!confirm)return;const target=confirm;busy.current=true;setPending(true);setError('');setMessage('');setConfirm(null)
  try{if(target==='others')await client.revokeOthers();else await client.revoke(target.id);if(target!=='others'&&target.current){onCurrentRevoked();return}if(alive.current){setRows(old=>old.filter(row=>target==='others'?row.current:row.id!==target.id));setMessage(target==='others'?'其他会话已撤销，当前会话保持登录。':'所选会话已撤销。')}}catch{if(alive.current)setError('撤销结果未确认。请先刷新会话列表核对，不要重复提交。')}finally{busy.current=false;if(alive.current)setPending(false)}
 }
 return <section aria-labelledby="local-sessions-title"><h4 id="local-sessions-title" className="set-field-label">登录会话</h4><p className="set-pane-desc">仅显示当前账号的有效会话。时间来自服务器；不推测设备或位置。撤销当前会话将返回登录页。</p><button type="button" className="set-btn" disabled={pending} onClick={()=>void refresh()}>刷新会话列表</button><button type="button" className="set-btn" disabled={pending||!!confirm||!rows.some(row=>!row.current)} onClick={()=>{setMessage('');setError('');setConfirm('others')}}>撤销所有其他会话</button>
 {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 {confirm&&<div className="set-field" role="group" aria-label="确认撤销会话"><p>{confirm==='others'?'确定撤销所有其他会话？当前会话将保持登录，未来新登录不受影响。':confirm.current?'确定撤销当前会话并退出登录？':'确定撤销所选会话？该会话将无法继续访问。'}</p><button type="button" className="set-btn danger" disabled={pending} onClick={()=>void revoke()}>确认撤销</button><button type="button" className="set-btn" disabled={pending} onClick={()=>setConfirm(null)}>取消</button></div>}
 <ul>{rows.map(row=><li key={row.id} data-session-id={row.id}><strong>{row.current?'当前浏览器会话':'其他登录会话'}</strong><p>创建：{new Date(row.createdAt).toLocaleString()}<br/>最近使用：{new Date(row.lastSeenAt).toLocaleString()}<br/>到期：{new Date(row.expiresAt).toLocaleString()}</p><button type="button" className="set-btn" disabled={pending||!!confirm} onClick={()=>{setMessage('');setError('');setConfirm(row)}}>{row.current?'撤销当前会话':'撤销此会话'}</button></li>)}</ul>
 </section>
}
