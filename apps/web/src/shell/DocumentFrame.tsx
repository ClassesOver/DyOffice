import {useEffect,useRef} from 'react'
import type {DocumentTab,DocumentCloseGuard} from './document-tabs'

type EditorWindow=Omit<Window,'dyofficeEditorCanClose'>&{dyofficeEditorCanClose?:()=>boolean|Promise<boolean>;dyofficeEditorDispose?:()=>boolean|Promise<boolean>}
export function DocumentFrame({file,registerGuard}:{file:DocumentTab;registerGuard:(id:string,guard:DocumentCloseGuard|null)=>void}){
 const frame=useRef<HTMLIFrameElement>(null)
 useEffect(()=>{
  registerGuard(file.id,async()=>{
   const editor=frame.current?.contentWindow as EditorWindow|null
   if(!editor?.dyofficeEditorCanClose||!editor.dyofficeEditorDispose){window.alert('编辑器正在加载，请稍候再关闭。');return false}
   if(!await editor.dyofficeEditorCanClose())return false
   return await editor.dyofficeEditorDispose()
  })
  return()=>registerGuard(file.id,null)
 },[file.id,registerGuard])
 return <iframe ref={frame} data-document-id={file.id} src={file.src} title={file.name} className="workspace-document-frame"/>
}
