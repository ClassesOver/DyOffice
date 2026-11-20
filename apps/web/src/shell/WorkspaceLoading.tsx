import {useEffect,useState} from 'react'
import logo from '../../../shell/src/renderer/src/assets/dyoffice-mark.svg'
import '../editors/document-loading.css'
import './workspace-loading.css'

export function WorkspaceLoading(){
 const [slow,setSlow]=useState(false)
 useEffect(()=>{const timer=setTimeout(()=>setSlow(true),8000);return()=>clearTimeout(timer)},[])
 return <main className="workspace-loading" aria-busy="true">
  <div className="document-loading">
   <div className="document-loading-card" role="status" aria-live="polite">
    <img className="workspace-loading-logo" src={logo} alt=""/>
    <strong className="workspace-loading-brand">DyOffice</strong>
    <span className="document-loading-status">正在加载个人工作区…</span>
    <div className="document-loading-track" aria-hidden="true"><span/></div>
    <div className="workspace-loading-preview" aria-hidden="true">
     <div className="workspace-loading-tabs"><i/><i/><i/></div>
     <div className="workspace-loading-body"><div className="workspace-loading-sidebar"><i/><i/><i/></div><div className="document-loading-skeleton"><i/><i/><i/></div></div>
    </div>
    <p className="document-loading-hint">{slow?'仍在加载，请稍候…':'即将回到你的文档与工作'}</p>
   </div>
  </div>
 </main>
}
