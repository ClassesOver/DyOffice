import React,{useEffect,useRef,useState} from 'react'
import {createAssistantClient} from '../../../../packages/browser-host/src/assistant'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import './home-assistant.css'
import {prepareHomeHistory} from './home-assistant-history'
const HOME_SYSTEM='You are the DyOffice home assistant. Answer questions in the user language. No document context, attachments, tools, or file operations are available in this chat.'
type Bound={proof:string;request:SettingsRequest}
type Assistant=Awaited<ReturnType<typeof createAssistantClient>>
type Message={role:'user'|'assistant';text:string}
export function HomeAssistant({bind,fetchImpl=fetch,recovery=false}:{bind:()=>Promise<Bound>;fetchImpl?:typeof fetch;recovery?:boolean}){
 const [open,setOpen]=useState(false)
 useEffect(()=>{if(recovery)setOpen(false)},[recovery])
 if(recovery)return null
 return <><button className="home-assistant-entry" onClick={()=>setOpen(true)}>AI 助手</button>{open&&<Chat bind={bind} fetchImpl={fetchImpl} onClose={()=>setOpen(false)}/>}</>
}
function Chat({bind,fetchImpl,onClose}:{bind:()=>Promise<Bound>;fetchImpl:typeof fetch;onClose:()=>void}){
 const [assistant,setAssistant]=useState<Assistant>(),[error,setError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0)
 const [messages,setMessages]=useState<Message[]>([]),[text,setText]=useState(''),[busy,setBusy]=useState(false),[model,setModel]=useState(''),[contextNotice,setContextNotice]=useState('')
 const active=useRef<{cancel():void}|undefined>(undefined),live=useRef(true),running=useRef(false)
 useEffect(()=>{
  let disposed=false;let current:Assistant|undefined;live.current=true
  setLoading(true);setError('');setAssistant(undefined);setMessages([])
  void bind().then(bound=>createAssistantClient({request:bound.request,csrfToken:bound.proof,fetchImpl})).then(value=>{
   current=value;if(disposed){value.dispose();return}const initial=value.catalog.entries.some(entry=>entry.id===value.selected())?value.selected()!:value.catalog.entries[0]?.id??'';if(initial)value.select(initial);setAssistant(value);setModel(initial);setLoading(false)
  }).catch(e=>{if(!disposed){setLoading(false);setError(e?.status===401||e?.status===403||e?.code==='stale_session'?'登录状态已失效，请重新登录或刷新工作区。':'助手加载失败，请检查连接后重试。')}})
  return()=>{disposed=true;live.current=false;active.current?.cancel();current?.dispose()}
 },[bind,fetchImpl,retry])
 function send(){
  const value=text.trim();if(running.current||!value||!assistant?.available||!model)return
  if(new TextEncoder().encode(value).length>32*1024){setError('消息过长，请缩短后再发送。');return}
  let prepared:ReturnType<typeof prepareHomeHistory>
  try{prepared=prepareHomeHistory(messages,value,history=>assistant.requestBytes({system:HOME_SYSTEM,messages:history,tools:[]}))}
  catch{setError('消息过长，请缩短后再发送。');return}
  const history=prepared.messages
  setContextNotice(prepared.truncated?'对话上下文已缩短：较早的完整交互已移出本次请求。':'')
  running.current=true;setBusy(true);setError('');setText('')
  setMessages([...history,{role:'assistant',text:''}]);assistant.transport.beginRun?.()
  let done=false
  const handle=assistant.transport.stream({system:HOME_SYSTEM,messages:history,tools:[]},{
   onDelta(delta){if(live.current)setMessages(rows=>rows.map((row,index)=>index===rows.length-1?{...row,text:row.text+delta}:row))},
   onToolCall(){throw Error('首页聊天不允许工具调用。')},
   onError(message){if(live.current)setError(message)},
   onDone(){
    done=true;running.current=false;active.current=undefined
    if(live.current){
     // A refused or stopped turn may have no text. Its visual placeholder is
     // not a provider message; sending it next time would invalidate history.
     setMessages(rows=>rows.at(-1)?.role==='assistant'&&rows.at(-1)?.text===''?rows.slice(0,-1):rows)
     setBusy(false)
    }
   },
  })
  if(!done)active.current=handle
 }
 return <section className="home-assistant-panel" role="dialog" aria-label="首页 AI 助手" aria-modal="false">
  <header><h2>AI 助手</h2><button onClick={onClose} aria-label="关闭助手">关闭</button></header>
  <p>首页问答 · 不读取或修改文档。关闭后清空本次对话。</p>
  {loading&&<p role="status">正在检查会话和可用模型…</p>}
  {error&&<p role="alert">{error}</p>}
  {contextNotice&&<p role="status">{contextNotice}</p>}
  {!loading&&!assistant&&<button onClick={()=>setRetry(n=>n+1)}>重试</button>}
  {assistant&&!assistant.available&&<><p role="status">没有可用模型。请在个人设置中检查模型配置、授权和调用额度；服务器也需启用模型网关。</p><button onClick={()=>setRetry(n=>n+1)}>重新检查</button></>}
  {assistant?.available&&<>
   <label>模型<select aria-label="聊天模型" value={model} disabled={busy} onChange={e=>{assistant.select(e.target.value);setModel(e.target.value);setMessages([]);setError('');setContextNotice('')}}>{assistant.catalog.entries.map(entry=><option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
   <div className="home-assistant-messages" role="log" aria-label="对话记录">{messages.map((message,index)=><div key={index}><strong>{message.role==='user'?'你':'助手'}</strong><p>{message.text||'…'}</p></div>)}</div>
   <form onSubmit={event=>{event.preventDefault();send()}}><label>消息<textarea aria-label="消息" value={text} maxLength={32768} disabled={busy} onChange={event=>setText(event.target.value)}/></label><button type="submit" disabled={busy||!text.trim()||!model}>发送</button>{busy&&<button type="button" onClick={()=>active.current?.cancel()}>停止</button>}</form>
  </>}
 </section>
}
