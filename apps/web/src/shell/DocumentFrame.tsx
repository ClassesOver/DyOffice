import type {DraftCopyFrame} from '../editors/draft-copy-authority'
import {Alert,Button} from 'antd'
import {useEffect,useRef,useState} from 'react'
import type {DocumentTab,DocumentCloseGuard} from './document-tabs'

type EditorWindow=Omit<Window,'dyofficeEditorCanClose'>&{dyofficeEditorCanClose?:()=>boolean|Promise<boolean>;dyofficeEditorDispose?:()=>boolean|Promise<boolean>}
export function DocumentFrame({file,registerGuard,sessionActive=()=>false}:{file:DocumentTab;registerGuard:(id:string,guard:DocumentCloseGuard|null)=>void;sessionActive?:()=>boolean}){
 const frame=useRef<HTMLIFrameElement>(null)
 const session=useRef(sessionActive),live=useRef(true)
 session.current=sessionActive
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 const bindFrame=(element:HTMLIFrameElement|null)=>{frame.current=element;if(element)(element as DraftCopyFrame).dyofficeDraftCopySessionActive=()=>live.current&&session.current()}
 const started=useRef(false),entryFailed=useRef(false)
 const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0)
 function failedEntry(){
  if(started.current)return false
  try{
   const document=frame.current?.contentDocument,editor=frame.current?.contentWindow as EditorWindow|null
   if(!document||document.URL!==new URL(file.src,window.location.href).href)return false
   if(editor?.dyofficeEditorCanClose||editor?.dyofficeEditorDispose||document.scripts.length||!['application/json','application/problem+json'].includes(document.contentType)){started.current=true;return false}
   const problem=JSON.parse(document.body?.textContent??'')
   return problem?.type==='about:blank'&&typeof problem.title==='string'&&Number.isInteger(problem.status)&&problem.status>=400&&problem.status<=599
  }catch{return false}
 }
 function loaded(){
  entryFailed.current=failedEntry()
  setFailed(entryFailed.current)
 }
 function retry(){
  if(!entryFailed.current)return
  if(!failedEntry()){entryFailed.current=false;setFailed(false);return}
  entryFailed.current=false;setFailed(false);setAttempt(value=>value+1)
 }
 useEffect(()=>{
  registerGuard(file.id,async()=>{
   if(entryFailed.current&&failedEntry())return true
   const editor=frame.current?.contentWindow as EditorWindow|null
   if(!editor?.dyofficeEditorCanClose||!editor.dyofficeEditorDispose){window.alert('编辑器正在加载，请稍候再关闭。');return false}
   if(!await editor.dyofficeEditorCanClose())return false
   return await editor.dyofficeEditorDispose()
  })
  return()=>registerGuard(file.id,null)
 },[file.id,registerGuard])
 return <>{failed&&<Alert role="alert" type="error" title="编辑器加载失败" description="请重新加载编辑器，或关闭此文档页签后再打开。" action={<Button onClick={retry}>重新加载编辑器</Button>}/>}<iframe key={attempt} ref={bindFrame} data-document-id={file.id} src={file.src} title={file.name} onLoad={loaded} className="workspace-document-frame" hidden={failed} style={failed?{display:'none'}:undefined}/></>
}
