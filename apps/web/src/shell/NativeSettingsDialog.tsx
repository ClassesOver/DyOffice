import {useEffect,useId,useRef,type ReactNode} from 'react'
import './native-settings.css'

export function NativeSettingsDialog({title,onClose,children,compact=false,footer}:{title:string;onClose:()=>void;children:ReactNode;compact?:boolean;footer?:ReactNode}){
 const dialog=useRef<HTMLDialogElement>(null),titleId=useId()
 useEffect(()=>{
  const node=dialog.current!,previous=document.activeElement as HTMLElement|null
  node.showModal()
  return()=>{node.close();if(previous?.isConnected)previous.focus()}
 },[])
 return <dialog ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`workspace-native-dialog${compact?' is-compact':''}`} onCancel={event=>{event.preventDefault();event.stopPropagation();onClose()}}>
  <header className="native-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="native-dialog-close" aria-label={`关闭${title}`} onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
  <div className="native-dialog-body">{children}</div>
  {footer&&<footer className="native-dialog-footer">{footer}</footer>}
 </dialog>
}
