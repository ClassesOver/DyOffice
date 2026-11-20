import type {ReactNode} from 'react'
import './settings-workbench.css'

export interface SettingsWorkbenchItem {
  key: string
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
}

export function SettingsWorkbench({ariaLabel,caption,footer,navigation,activeKey,onNavigationChange,title,description,status,actions,children}:{
  ariaLabel:string;caption?:string;footer?:ReactNode;navigation:readonly SettingsWorkbenchItem[];activeKey:string;onNavigationChange:(key:string)=>void
  title:string;description?:string;status?:ReactNode;actions?:ReactNode;children:ReactNode
}) {
  return <section className="settings-workbench" aria-label={ariaLabel}>
    <aside className="settings-workbench-nav">
      {caption&&<span className="settings-workbench-caption">{caption}</span>}
      <nav aria-label={`${ariaLabel}分类`}>{navigation.map(item=><button key={item.key} type="button" className={`settings-workbench-nav-item${activeKey===item.key?' is-active':''}`} aria-current={activeKey===item.key?'page':undefined} disabled={item.disabled} onClick={()=>onNavigationChange(item.key)}>
        {item.icon&&<span className="settings-workbench-nav-icon" aria-hidden="true">{item.icon}</span>}<span><strong>{item.label}</strong>{item.description&&<small>{item.description}</small>}</span>
      </button>)}</nav>
      {footer&&<div className="settings-workbench-footer">{footer}</div>}
    </aside>
    <div className="settings-workbench-main">
      <header className="settings-workbench-header"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>{actions&&<div className="settings-workbench-actions">{actions}</div>}</header>
      {status&&<div className="settings-workbench-status">{status}</div>}
      <div className="settings-workbench-content">{children}</div>
    </div>
  </section>
}
