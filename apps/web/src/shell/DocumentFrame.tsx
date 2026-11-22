import {DocumentLoading} from '../editors/DocumentLoading'
import type {DocumentLoadingState} from '../editors/document-loading-state'
import type {DraftCopyFrame} from '../editors/draft-copy-authority'
import {Alert,Button} from 'antd'
import {useEffect,useRef,useState} from 'react'
import type {DocumentTab,DocumentCloseGuard} from './document-tabs'

type EditorWindow=Omit<Window,'dyofficeEditorCanClose'>&{dyofficeEditorCanClose?:()=>boolean|Promise<boolean>;dyofficeEditorDispose?:()=>boolean|Promise<boolean>}
export function DocumentFrame({file,registerGuard,sessionActive=()=>false,onAutoPdfName}:{file:DocumentTab;registerGuard:(id:string,guard:DocumentCloseGuard|null)=>void;sessionActive?:()=>boolean;onAutoPdfName?:(id:string,previous:string,name:string)=>void}){
 const embedded=window.parent!==window&&new URLSearchParams(location.search).get('dshEmbed')==='1'
 const source=embedded?file.src+'&dshEmbed=1':file.src
 const frame=useRef<HTMLIFrameElement>(null)
 const session=useRef(sessionActive),live=useRef(true)
 session.current=sessionActive
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 const bindFrame=(element:HTMLIFrameElement|null)=>{frame.current=element;if(element)(element as DraftCopyFrame).dyofficeDraftCopySessionActive=()=>live.current&&session.current()}
 const started=useRef(false),entryFailed=useRef(false)
 const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0)
 const [loadingState,setLoadingState]=useState<DocumentLoadingState>('reading')
 const retrying=useRef(false)
 useEffect(()=>{
  const workspaceRoot=document.documentElement
  const syncTheme=()=>{
   const editorRoot=frame.current?.contentDocument?.documentElement
   if(!editorRoot)return
   const theme=workspaceRoot.dataset.theme
   if(theme==='light'||theme==='dark')editorRoot.dataset.theme=theme
   else delete editorRoot.dataset.theme
  }
  const themeObserver=new MutationObserver(syncTheme)
  themeObserver.observe(workspaceRoot,{attributes:true,attributeFilter:['data-theme']})
  const receive=(event:MessageEvent)=>{
   if(event.source!==frame.current?.contentWindow||event.origin!==location.origin)return
   if(event.data?.type==='dyoffice-document-loading'&&['reading','rendering','ready','error'].includes(event.data.state)){
    setLoadingState(event.data.state)
    if(event.data.state==='ready')syncTheme()
   }
   if(event.data?.type==='dyoffice-pdf-auto-name'&&file.format==='pdf'&&session.current()&&
      typeof event.data.previous==='string'&&typeof event.data.name==='string'&&event.data.name.length<=255){
    onAutoPdfName?.(file.id,event.data.previous,event.data.name)
   }
  }
  window.addEventListener('message',receive)
  return()=>{
   themeObserver.disconnect()
   window.removeEventListener('message',receive)
  }
 },[file.id,file.format,onAutoPdfName])
 async function retryEditor(){
  if(retrying.current)return
  retrying.current=true
  try{
   const editor=frame.current?.contentWindow as EditorWindow|null
   if(!editor?.dyofficeEditorCanClose||!editor.dyofficeEditorDispose||!await editor.dyofficeEditorCanClose()||!await editor.dyofficeEditorDispose())return
   started.current=false;entryFailed.current=false;setFailed(false);setLoadingState('reading');setAttempt(value=>value+1)
  }finally{retrying.current=false}
 }
 function failedEntry(){
  if(started.current)return false
  try{
   const document=frame.current?.contentDocument,editor=frame.current?.contentWindow as EditorWindow|null
   if(!document||document.URL!==new URL(source,window.location.href).href)return false
   if(editor?.dyofficeEditorCanClose||editor?.dyofficeEditorDispose||document.scripts.length||!['application/json','application/problem+json'].includes(document.contentType)){started.current=true;return false}
   const problem=JSON.parse(document.body?.textContent??'')
   return problem?.type==='about:blank'&&typeof problem.title==='string'&&Number.isInteger(problem.status)&&problem.status>=400&&problem.status<=599
  }catch{return false}
 }
 function loaded(){
  entryFailed.current=failedEntry()
  setFailed(entryFailed.current)
  const state=frame.current?.contentDocument?.documentElement?.dataset.documentLoading
  if(state&&['reading','rendering','ready','error'].includes(state))setLoadingState(state as DocumentLoadingState)
 }
 function retry(){
  if(!entryFailed.current)return
  if(!failedEntry()){entryFailed.current=false;setFailed(false);return}
  entryFailed.current=false;setFailed(false);setLoadingState('reading');setAttempt(value=>value+1)
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
 return <div className="document-loading-host">{!failed&&loadingState!=='ready'&&<DocumentLoading key={attempt} name={file.name} format={file.format} state={loadingState} onRetry={()=>{void retryEditor()}}/>}{failed&&<Alert role="alert" type="error" title="编辑器加载失败" description="请重新加载编辑器，或关闭此文档页签后再打开。" action={<Button onClick={retry}>重新加载编辑器</Button>}/>}<div className="document-loading-content" data-loading={!failed&&loadingState!=='ready'} aria-busy={!failed&&loadingState!=='ready'}><iframe key={attempt} ref={bindFrame} data-document-id={file.id} src={source} title={file.name} onLoad={loaded} className="workspace-document-frame" hidden={failed} style={failed?{display:'none'}:undefined}/></div></div>
}
