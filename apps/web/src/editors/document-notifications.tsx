import {useEffect,useState,type ReactNode} from 'react'
import './document-notifications.css'

export interface DocumentNotification {
  id: string
  level: 'info' | 'warning' | 'error'
  title: string
  message: string
  actions?: ReactNode
}
/** Scoped to the open document: notifications never change the editor's layout or authority. */
export function DocumentNotifications({items,locale='zh'}:{items:DocumentNotification[];locale?:'zh'|'en'}) {
  const [hidden,setHidden]=useState<Set<string>>(()=>new Set())
  const key=(item:DocumentNotification)=>`${item.id}:${item.level}:${item.message}`
  const signature=items.map(key).join('\n')
  useEffect(()=>{
    const active=new Set(items.map(key))
    setHidden(previous=>new Set([...previous].filter(value=>active.has(value))))
    const timers=items.filter(item=>item.level==='info').map(item=>setTimeout(()=>setHidden(previous=>new Set([...previous,key(item)])),6000))
    return()=>timers.forEach(clearTimeout)
  },[signature])
  const visible=items.filter(item=>!hidden.has(key(item)))
  if(!items.length)return null
  const zh=locale==='zh'
  return <aside className="document-notifications" aria-label={zh?'文档消息通知':'Document notifications'}>
    <div className="document-notification-stack" aria-live="polite" aria-relevant="additions text">
      {visible.map(item=><section className="document-notification" data-level={item.level} key={key(item)} role={item.level==='error'?'alert':'status'}>
        <span className="document-notification-icon" aria-hidden="true">{item.level==='info'?'i':'!'}</span>
        <div className="document-notification-content"><strong>{item.title}</strong><p>{item.message}</p>{item.actions&&<div className="document-notification-actions">{item.actions}</div>}</div>
        <button className="document-notification-close" aria-label={zh?'关闭通知':'Dismiss notification'} onClick={()=>setHidden(previous=>new Set([...previous,key(item)]))}>×</button>
      </section>)}
    </div>
    <button className="document-notification-trigger" aria-label={zh?`消息通知（${items.length}）`:`Notifications (${items.length})`} aria-expanded={visible.length>0} onClick={()=>setHidden(visible.length?new Set(items.map(key)):new Set())}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
      <span>{zh?'消息通知':'Notifications'}</span><span className="document-notification-count">{items.length}</span>
    </button>
  </aside>
}
