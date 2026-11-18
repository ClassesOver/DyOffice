import React,{useId,useRef,useState} from 'react'
import {Avatar,Dropdown,Tag,theme,type MenuProps} from 'antd'
import {DatabaseOutlined,DeleteOutlined,DownOutlined,LogoutOutlined,SettingOutlined,SlidersOutlined,TeamOutlined,UpOutlined} from '@ant-design/icons'
import './account-menu.css'

export type AccountMenuProps={
 user:{username:string;displayName:string;roles:string[]}|null
 onSettings:()=>void;onTrash:()=>void;onSources:()=>void
 onGlobalSettings:()=>void;onUsers:()=>void;onLogout:()=>void
}

export function AccountMenu(props:AccountMenuProps){
 const {user}=props
 const {token}=theme.useToken()
 const [expanded,setExpanded]=useState(false)
 const trigger=useRef<HTMLButtonElement>(null)
 const menuId=useId()
 const name=user?.displayName||user?.username||'用户'
 const admin=!!user?.roles.includes('config_admin')
 const actions:Record<string,()=>void>={settings:props.onSettings,trash:props.onTrash,sources:props.onSources,global:props.onGlobalSettings,users:props.onUsers,logout:props.onLogout}
 const items:MenuProps['items']=[
  {type:'group',key:'personal',label:'个人工作区',children:[
   {key:'settings',label:'个人设置',icon:<SettingOutlined aria-hidden="true"/>},
   {key:'trash',label:'回收站',icon:<DeleteOutlined aria-hidden="true"/>},
  ]},
  ...(admin?[{type:'divider' as const},{type:'group' as const,key:'administration',label:'组织管理',children:[
   {key:'sources',label:'数据连接',icon:<DatabaseOutlined aria-hidden="true"/>},
   {key:'global',label:'全局配置',icon:<SlidersOutlined aria-hidden="true"/>},
   {key:'users',label:'用户管理',icon:<TeamOutlined aria-hidden="true"/>},
  ]}]:[]),
  {type:'divider'},
  {key:'logout',label:'退出登录',icon:<LogoutOutlined aria-hidden="true"/>,danger:true},
 ]
 function close(){setExpanded(false);trigger.current?.focus()}
 return <Dropdown open={expanded} onOpenChange={setExpanded} trigger={['click']} placement="topLeft" autoFocus destroyOnHidden
  menu={{id:menuId,'aria-label':'账号菜单',items,selectable:false,onClick:({key})=>{close();actions[key]?.()}}}
  popupRender={menu=><div tabIndex={-1} onFocus={event=>{if(event.target===event.currentTarget)event.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus()}} className="account-menu-popover" style={{background:token.colorBgElevated,borderRadius:token.borderRadiusLG,boxShadow:token.boxShadowSecondary,color:token.colorText}} onKeyDown={event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}
   if(event.key==='Tab')close()
  }}>
   <div className="account-menu-profile"><Avatar size={38} shape="square" style={{background:token.colorPrimaryBg,color:token.colorPrimaryText}}>{Array.from(name)[0]}</Avatar><div className="account-menu-identity"><strong>{name}</strong><span style={{color:token.colorTextSecondary}} title={user?.username}>{user?.username}</span></div><Tag>{admin?'管理员':'成员'}</Tag></div>
   {menu}
  </div>}
 >
  <button ref={trigger} type="button" className="account-btn account-menu-trigger" aria-label={`${name}，账号菜单`} aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded?menuId:undefined} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setExpanded(true)}}}>
   <Avatar size={28} style={{background:token.colorPrimaryBg,color:token.colorPrimaryText}}>{Array.from(name)[0]}</Avatar><span className="account-text"><span className="account-name">{name}</span><span className="account-sub">个人工作区</span></span>
   {expanded?<UpOutlined className="account-menu-chevron" aria-hidden="true"/>:<DownOutlined className="account-menu-chevron" aria-hidden="true"/>}
  </button>
 </Dropdown>
}
