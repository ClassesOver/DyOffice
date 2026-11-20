import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import './account-menu.css'

export type AccountMenuProps={
 user:{username:string;displayName:string;roles:string[]}|null
 onChannels?:()=>void;onTasks?:()=>void
 onSettings:()=>void;onTrash:()=>void;onSources:()=>void
 onGlobalSettings:()=>void;onUsers:()=>void;onLogout:()=>void
}
type IconName='settings'|'channels'|'tasks'|'trash'|'sources'|'global'|'users'|'logout'
const iconPaths:Record<IconName,React.ReactNode>={
 settings:<><path d="m9 3 .6 2.2a7 7 0 0 1 1.8 0L12 3l2.6 1.5-.6 2.2a7 7 0 0 1 .9 1.6l2.2.6v3l-2.2.6a7 7 0 0 1-.9 1.6l.6 2.2L12 18l-.6-2.2a7 7 0 0 1-1.8 0L9 18l-2.6-1.5.6-2.2a7 7 0 0 1-.9-1.6l-2.2-.6v-3l2.2-.6A7 7 0 0 1 7 6.7l-.6-2.2Z"/><circle cx="10.5" cy="10.5" r="2.5"/></>,
 channels:<><circle cx="5" cy="10" r="2"/><circle cx="15" cy="4" r="2"/><circle cx="15" cy="16" r="2"/><path d="m7 9 6-4M7 11l6 4"/></>,
 tasks:<><rect x="4" y="3" width="12" height="15" rx="2"/><path d="M8 7h5M8 11h5M8 15h3"/></>,
 trash:<><path d="M3 5h14M8 5V3h4v2M5 5l1 13h8l1-13M8 8v7M12 8v7"/></>,
 sources:<><ellipse cx="10" cy="4" rx="7" ry="2.5"/><path d="M3 4v11c0 3.3 14 3.3 14 0V4M3 9c0 3.3 14 3.3 14 0"/></>,
 global:<><path d="M4 3v14M10 3v14M16 3v14M2 7h4M8 13h4M14 7h4"/><circle cx="4" cy="7" r="1.5"/><circle cx="10" cy="13" r="1.5"/><circle cx="16" cy="7" r="1.5"/></>,
 users:<><circle cx="8" cy="6" r="3"/><path d="M2 18v-2a6 6 0 0 1 12 0v2M14 3a3 3 0 0 1 0 6M16 12a5 5 0 0 1 3 4v2"/></>,
 logout:<><path d="M8 3H4v14h4M8 10h10m-4-4 4 4-4 4"/></>,
}
function Icon({name}:{name:IconName}){return <svg className="account-menu-icon" viewBox="0 0 20 21" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>}

export function AccountMenu(props:AccountMenuProps){
 const {user}=props
 const [expanded,setExpanded]=useState(false)
 const [position,setPosition]=useState({left:12,top:12,maxHeight:600})
 const trigger=useRef<HTMLButtonElement>(null)
 const popup=useRef<HTMLDivElement>(null)
 const initialFocus=useRef<'first'|'last'>('first')
 const menuId=useId()
 const name=user?.displayName||user?.username||'用户'
 const admin=!!user?.roles.includes('config_admin')
 const personal:Array<{key:IconName;label:string;action:()=>void}>=[
  {key:'settings',label:'个人设置',action:props.onSettings},
  ...(props.onChannels?[{key:'channels' as const,label:'频道分享',action:props.onChannels}]:[]),
  ...(props.onTasks?[{key:'tasks' as const,label:'后台任务',action:props.onTasks}]:[]),
  {key:'trash',label:'回收站',action:props.onTrash},
 ]
 const organization=[{key:'sources' as const,label:'数据连接',action:props.onSources},{key:'global' as const,label:'全局配置',action:props.onGlobalSettings},{key:'users' as const,label:'用户管理',action:props.onUsers}]
 function close(restoreFocus=false){setExpanded(false);if(restoreFocus)trigger.current?.focus()}
 function open(last=false){initialFocus.current=last?'last':'first';setExpanded(true)}
 useLayoutEffect(()=>{
  if(!expanded)return
  function align(){
   const rect=trigger.current?.getBoundingClientRect();if(!rect)return
   const width=Math.min(window.innerWidth<=480?300:320,window.innerWidth-24)
   const above=Math.max(0,rect.top-20),below=Math.max(0,window.innerHeight-rect.bottom-20)
   const downward=below>=above,maxHeight=downward?below:above
   const height=Math.min((popup.current?.scrollHeight??0)+2,maxHeight)
   setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:downward?rect.bottom+8:Math.max(12,rect.top-8-height),maxHeight})
  }
  align()
  const entries=popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  if(entries?.length)entries[initialFocus.current==='last'?entries.length-1:0].focus()
  window.addEventListener('resize',align);window.addEventListener('scroll',align,true)
  return ()=>{window.removeEventListener('resize',align);window.removeEventListener('scroll',align,true)}
 },[expanded])
 useEffect(()=>{
  if(!expanded)return
  function outside(event:PointerEvent){const target=event.target as Node;if(!trigger.current?.contains(target)&&!popup.current?.contains(target))close()}
  document.addEventListener('pointerdown',outside)
  return ()=>document.removeEventListener('pointerdown',outside)
 },[expanded])
 const renderItem=(item:{key:IconName;label:string;action:()=>void})=><button key={item.key} type="button" role="menuitem" tabIndex={-1} className={`account-menu-item${item.key==='logout'?' account-menu-item-danger':''}`} onClick={()=>{close(true);item.action()}}><Icon name={item.key}/><span>{item.label}</span></button>
 return <>
  <button ref={trigger} type="button" className="account-btn account-menu-trigger" aria-label={`${name}，账号菜单`} aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded?menuId:undefined} onClick={()=>expanded?close():open()} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open(event.key==='ArrowUp')}}}>
   <span className="account-menu-avatar" aria-hidden="true">{Array.from(name)[0]}</span><span className="account-text"><span className="account-name">个人工作区</span><span className="account-sub" title={name}>{name}</span></span>
   <span className="account-menu-toggle" aria-hidden="true"><svg className="account-menu-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={expanded?'m4 10 4-4 4 4':'m4 6 4 4 4-4'}/></svg></span>
  </button>
  {expanded&&createPortal(<div ref={popup} className="account-menu-popover" style={position}>
   <div className="account-menu-heading"><span>个人工作区</span><span className="account-menu-role">{admin?'管理员':'成员'}</span></div>
   <div className="account-menu-profile"><span className="account-menu-avatar" aria-hidden="true">{Array.from(name)[0]}</span><div className="account-menu-identity"><strong>{name}</strong><span title={user?.username}>{user?.username}</span></div></div>
   <div id={menuId} role="menu" aria-label="账号菜单" onKeyDown={event=>{
    const entries=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')],index=entries.indexOf(document.activeElement as HTMLButtonElement)
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true)}
    else if(event.key==='Tab')close()
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
     event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?entries.length-1:(index+(event.key==='ArrowDown'?1:-1)+entries.length)%entries.length;entries[next]?.focus()
    }
   }}>
    <div role="group" aria-label="个人工作区"><div className="account-menu-group-title" aria-hidden="true">个人工作区</div>{personal.map(renderItem)}</div>
    {admin&&<><div role="separator" className="account-menu-separator"/><div role="group" aria-label="组织管理"><div className="account-menu-group-title" aria-hidden="true">组织管理</div>{organization.map(renderItem)}</div></>}
    <div role="separator" className="account-menu-separator"/>{renderItem({key:'logout',label:'退出登录',action:props.onLogout})}
   </div>
  </div>,document.body)}
 </>
}
