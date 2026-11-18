import {Alert, Button, Tag} from 'antd'
import React,{useEffect,useRef,useState} from 'react'
import {SettingsListPager} from './SettingsListPager'
import {loginHistoryClient,type LoginHistoryClient,type LoginHistoryEvent} from './local-login-history-client'
const outcomes={success:'登录成功',failure:'登录失败',throttled:'登录请求受限'}
const pageSize=5
export function LoginHistoryPanel({client=loginHistoryClient}:{client?:Pick<LoginHistoryClient,'listPage'>}){
 const [events,setEvents]=useState<LoginHistoryEvent[]>([]),[state,setState]=useState<'loading'|'ready'|'error'>('loading')
 const [page,setPage]=useState(0),[nextCursor,setNextCursor]=useState<string|null>(null)
 const cursors=useRef<(string|undefined)[]>([undefined]),generation=useRef(0),pending=useRef(false)
 const region=useRef<HTMLDivElement>(null)
 async function load(target=0){
  if(pending.current)return
  const request=++generation.current
  pending.current=true;setState('loading');setEvents([])
  try{
   const result=await client.listPage({limit:pageSize,after:cursors.current[target]})
   if(request!==generation.current)return
   if(target===0)cursors.current=[undefined]
   cursors.current=cursors.current.slice(0,target+1)
   if(result.nextCursor)cursors.current[target+1]=result.nextCursor
   setEvents(result.events);setPage(target);setNextCursor(result.nextCursor);setState('ready')
   if(region.current)region.current.scrollTop=0
  }catch{if(request===generation.current){setNextCursor(null);setState('error')}}
  finally{if(request===generation.current)pending.current=false}
 }
 useEffect(()=>{pending.current=false;cursors.current=[undefined];setPage(0);void load();return()=>{generation.current++}},[client])
 return <section className="personal-account-section" aria-labelledby="login-history-title"><h4 id="login-history-title" className="personal-account-section-title">登录历史摘要</h4><p className="personal-account-section-desc">已保留且可归属当前账号的记录；早期失败记录可能不包含。这不是完整审计记录，不展示设备或位置。每页 5 条，可翻页查看更早的已保留记录。</p><Button autoInsertSpace={false} htmlType="button" disabled={state==='loading'} onClick={()=>void load()}>刷新登录历史</Button>
 {state==='loading'&&<p className="personal-account-empty" role="status">正在读取登录历史…</p>}{state==='error'&&<Alert type="error" showIcon title="登录历史暂不可用，请刷新或重新登录。"/>}
 {state==='ready'&&events.length===0&&<p className="personal-account-empty">暂无可显示的登录记录。</p>}
 <div ref={region} className="settings-list-scroll-region" role="region" aria-label="登录历史记录" tabIndex={0} aria-busy={state==='loading'}>
 {state==='ready'&&events.length>0&&<ul className="personal-history-list">{events.map((event,index)=><li key={index} data-history-event={event.outcome}><Tag color={event.outcome==='success'?'success':event.outcome==='throttled'?'warning':'error'}>{outcomes[event.outcome]}</Tag><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time></li>)}</ul>}
 </div>
 <SettingsListPager page={page} pageSize={pageSize} hasPrevious={state==='ready'&&page>0} hasNext={state==='ready'&&nextCursor!==null} onPageChange={target=>void load(target)} disabled={state!=='ready'} label="登录记录"/>
 </section>
}
