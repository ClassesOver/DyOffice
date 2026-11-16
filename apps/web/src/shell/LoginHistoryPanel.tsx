import React,{useEffect,useRef,useState} from 'react'
import {loginHistoryClient,type LoginHistoryClient,type LoginHistoryEvent} from './local-login-history-client'
const outcomes={success:'登录成功',failure:'登录失败',throttled:'登录请求受限'}
export function LoginHistoryPanel({client=loginHistoryClient}:{client?:LoginHistoryClient}){
 const [events,setEvents]=useState<LoginHistoryEvent[]>([]),[state,setState]=useState<'loading'|'ready'|'error'>('loading')
 const generation=useRef(0)
 async function load(){const request=++generation.current;setState('loading');setEvents([]);try{const result=await client.list();if(request===generation.current){setEvents(result);setState('ready')}}catch{if(request===generation.current)setState('error')}}
 useEffect(()=>{void load();return()=>{generation.current++}},[client])
 return <section aria-labelledby="login-history-title"><h4 id="login-history-title" className="set-field-label">登录历史摘要</h4><p className="set-pane-desc">最近 20 条可归属当前账号的记录；早期失败记录可能不包含。这不是完整审计记录，不展示设备或位置。</p><button type="button" className="set-btn" disabled={state==='loading'} onClick={()=>void load()}>刷新登录历史</button>
 {state==='loading'&&<p role="status">正在读取登录历史…</p>}{state==='error'&&<p role="alert">登录历史暂不可用，请刷新或重新登录。</p>}
 {state==='ready'&&events.length===0&&<p>暂无可显示的登录记录。</p>}
 {state==='ready'&&<ul>{events.map((event,index)=><li key={index} data-history-event={event.outcome}><strong>{outcomes[event.outcome]}</strong> · <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time></li>)}</ul>}
 </section>
}
