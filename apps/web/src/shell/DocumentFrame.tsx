import {DocumentLoading} from '../editors/DocumentLoading'
import type {DocumentLoadingState} from '../editors/document-loading-state'
import type {DraftCopyFrame} from '../editors/draft-copy-authority'
import {dispatchBrowserDocumentCommand,type BrowserDocumentCommand,type WorkspaceOpenFrame} from '../editors/browser-document-command'
import {Alert,Button} from 'antd'
import {useEffect,useRef,useState} from 'react'
import type {DocumentTab,DocumentCloseGuard} from './document-tabs'
import {isWorkspaceFileName,type WorkbookImportFormat} from './workspace-file-formats'

type EditorWindow=Omit<Window,'dyofficeEditorCanClose'>&{dyofficeEditorCanClose?:()=>boolean|Promise<boolean>;dyofficeEditorDispose?:()=>boolean|Promise<boolean>;dyofficeEditorCanSleep?:()=>boolean}
export type DocumentMenuCommand={id:string;command:BrowserDocumentCommand;claim:()=>boolean;complete:(handled:boolean)=>void}
export function DocumentFrame({file,registerGuard,registerSleepGuard,sessionActive=()=>false,onAutoFileName,documentShortcutsActive=false,onOpenShortcut,onOpenWorkspaceFile,onSaveAssistantSide,takeOfficeImportUnlock,menuCommand,onPaneInteraction,onDropWorkspaceFiles,workbookImports=[]}:{file:DocumentTab;registerGuard:(id:string,guard:DocumentCloseGuard|null)=>void;registerSleepGuard?:(id:string,guard:DocumentCloseGuard|null)=>void;sessionActive?:()=>boolean;onAutoFileName?:(id:string,previous:string,name:string)=>void;documentShortcutsActive?:boolean;onOpenShortcut?:(event:KeyboardEvent)=>void;onOpenWorkspaceFile?:()=>boolean;onSaveAssistantSide?:WorkspaceOpenFrame['dyofficeSaveAssistantSide'];takeOfficeImportUnlock?:(fileId:string,revision:string)=>string|undefined;menuCommand?:DocumentMenuCommand|null;onPaneInteraction?:()=>void;onDropWorkspaceFiles?:(files:File[])=>void;workbookImports?:readonly WorkbookImportFormat[]}){
 const embedded=window.parent!==window&&new URLSearchParams(location.search).get('dshEmbed')==='1'
 const source=embedded?file.src+'&dshEmbed=1':file.src
 const frame=useRef<HTMLIFrameElement>(null)
 const session=useRef(sessionActive),live=useRef(true)
 session.current=sessionActive
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 const started=useRef(false),entryFailed=useRef(false)
 const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0)
 const [loadingState,setLoadingState]=useState<DocumentLoadingState>('reading')
 const bindFrame=(element:(DraftCopyFrame&WorkspaceOpenFrame)|null)=>{
  frame.current=element
  if(!element)return
  element.dyofficeDraftCopySessionActive=()=>live.current&&session.current()
  element.dyofficeTakeOfficeImportUnlock=(file.format==='xlsx'||file.format==='docx')&&takeOfficeImportUnlock
   ? revision=>live.current&&frame.current===element&&element.isConnected&&session.current()?takeOfficeImportUnlock(file.id,revision):undefined
   : undefined
  element.dyofficeSaveAssistantSide=onSaveAssistantSide&&((side,proof)=>{
   if(!live.current||frame.current!==element||!element.isConnected||!session.current())return Promise.reject(new Error('Workspace session ended'))
   return onSaveAssistantSide(side,proof)
  })
  element.dyofficeOpenWorkspaceFile=onOpenWorkspaceFile&&(()=>{
   if(!live.current||frame.current!==element||!element.isConnected||!session.current()||
      (!documentShortcutsActive&&!onPaneInteraction)||failed||loadingState!=='ready')return false
   if(!onOpenWorkspaceFile())return false
   onPaneInteraction?.()
   return true
  })
 }
 const retrying=useRef(false)
 useEffect(()=>{
  if(!documentShortcutsActive||failed||loadingState!=='ready')return
  const handleShortcut=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||event.altKey||event.isComposing||
      !(event.ctrlKey||event.metaKey)||!session.current())return
   const key=event.key.toLowerCase()
   const command=key==='s'?(event.shiftKey?'save-as':'save'):key==='p'&&!event.shiftKey?'print':undefined
   if(!command)return
   const editor=frame.current?.contentWindow
   if(editor&&(event.repeat||dispatchBrowserDocumentCommand(editor,command)))event.preventDefault()
  }
  window.addEventListener('keydown',handleShortcut)
  return()=>window.removeEventListener('keydown',handleShortcut)
 },[failed,loadingState,documentShortcutsActive])
 useEffect(()=>{
  if((file.format!=='docx'&&file.format!=='pptx')||failed||loadingState!=='ready'||
     (!documentShortcutsActive&&!onPaneInteraction))return
  const editor=frame.current?.contentDocument?.defaultView
  if(!editor)return
  const zoom=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||event.altKey||event.isComposing||
      !(event.ctrlKey||event.metaKey)||!session.current())return
   let command:BrowserDocumentCommand
   if(event.key==='+'||(event.key==='='&&!event.shiftKey))command='zoom-in'
   else if(event.key==='-'&&!event.shiftKey)command='zoom-out'
   else if(event.key==='0'&&!event.shiftKey)command='zoom-reset'
   else return
   if(dispatchBrowserDocumentCommand(editor,command))event.preventDefault()
  }
  if(documentShortcutsActive)window.addEventListener('keydown',zoom)
  editor.addEventListener('keydown',zoom,true)
  return()=>{
   window.removeEventListener('keydown',zoom)
   editor.removeEventListener('keydown',zoom,true)
  }
 },[documentShortcutsActive,failed,file.format,loadingState,onPaneInteraction])
 useEffect(()=>{
  if(!onDropWorkspaceFiles||failed||loadingState!=='ready'||
     (!documentShortcutsActive&&!onPaneInteraction))return
  const editor=frame.current?.contentDocument?.defaultView
  if(!editor)return
  const dragOver=(event:DragEvent)=>{
   if(event.dataTransfer?.types.includes('Files'))event.preventDefault()
  }
  const drop=(event:DragEvent)=>{
   // The editor has priority for its own drops, including images and attachments.
   const files=Array.from(event.dataTransfer?.files??[])
   if(event.defaultPrevented||!files.length)return
   event.preventDefault()
   if(session.current()&&files.some(file=>isWorkspaceFileName(file.name,workbookImports)))onDropWorkspaceFiles(files)
  }
  editor.addEventListener('dragover',dragOver)
  editor.addEventListener('drop',drop)
  return()=>{
   editor.removeEventListener('dragover',dragOver)
   editor.removeEventListener('drop',drop)
  }
 },[workbookImports,documentShortcutsActive,failed,loadingState,onDropWorkspaceFiles,onPaneInteraction])
 const consumedMenuCommand=useRef<DocumentMenuCommand|null>(null)
 useEffect(()=>{
  if(!menuCommand||menuCommand.id!==file.id||consumedMenuCommand.current===menuCommand||
     !documentShortcutsActive||!session.current())return
  const ready=!failed&&loadingState==='ready'
  if(!ready&&!failed&&loadingState!=='error'&&loadingState!=='citation-expired')return
  if(!menuCommand.claim())return
  consumedMenuCommand.current=menuCommand
  menuCommand.complete(ready&&dispatchBrowserDocumentCommand(frame.current?.contentWindow,menuCommand.command))
 },[menuCommand,file.id,documentShortcutsActive,failed,loadingState])
 useEffect(()=>{
  if(!onOpenShortcut||(!documentShortcutsActive&&!onPaneInteraction)||failed||loadingState!=='ready')return
  // The workspace owns Open. Capture it inside the active same-origin frame
  // before a shared editor handles its desktop Open shortcut.
  const editor=frame.current?.contentDocument?.defaultView
  editor?.addEventListener('keydown',onOpenShortcut,true)
  return()=>editor?.removeEventListener('keydown',onOpenShortcut,true)
 },[failed,loadingState,documentShortcutsActive,onOpenShortcut,onPaneInteraction])
 useEffect(()=>{
  if(!onPaneInteraction||failed||loadingState!=='ready')return
  const editor=frame.current?.contentDocument?.defaultView
  editor?.addEventListener('focusin',onPaneInteraction,true)
  editor?.addEventListener('pointerdown',onPaneInteraction,true)
  editor?.addEventListener('keydown',onPaneInteraction,true)
  return()=>{
   editor?.removeEventListener('focusin',onPaneInteraction,true)
   editor?.removeEventListener('pointerdown',onPaneInteraction,true)
   editor?.removeEventListener('keydown',onPaneInteraction,true)
  }
 },[failed,loadingState,onPaneInteraction])
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
   if(event.data?.type==='dyoffice-document-loading'&&['reading','rendering','ready','error','citation-expired'].includes(event.data.state)){
    setLoadingState(event.data.state)
    if(event.data.state==='ready')syncTheme()
   }
   if((event.data?.type==='dyoffice-file-auto-name'||(event.data?.type==='dyoffice-pdf-auto-name'&&file.format==='pdf'))&&session.current()&&
      typeof event.data.previous==='string'&&typeof event.data.name==='string'&&event.data.name.length<=255){
    onAutoFileName?.(file.id,event.data.previous,event.data.name)
   }
  }
  window.addEventListener('message',receive)
  return()=>{
   themeObserver.disconnect()
   window.removeEventListener('message',receive)
  }
 },[file.id,file.format,onAutoFileName])
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
  if(state&&['reading','rendering','ready','error','citation-expired'].includes(state))setLoadingState(state as DocumentLoadingState)
 }
 function retry(){
  if(!entryFailed.current)return
  if(!failedEntry()){entryFailed.current=false;setFailed(false);return}
  entryFailed.current=false;setFailed(false);setLoadingState('reading');setAttempt(value=>value+1)
 }
 useEffect(()=>{
  registerGuard(file.id,async canDispose=>{
   if(entryFailed.current&&failedEntry())return true
   const editor=frame.current?.contentWindow as EditorWindow|null
   if(!editor?.dyofficeEditorCanClose||!editor.dyofficeEditorDispose){window.alert('编辑器正在加载，请稍候再关闭。');return false}
   if(!await editor.dyofficeEditorCanClose())return false
   if(canDispose&&!canDispose())return false
   return await editor.dyofficeEditorDispose()
  })
  return()=>registerGuard(file.id,null)
 },[file.id,registerGuard])
 useEffect(()=>{
  if(!registerSleepGuard||failed||loadingState!=='ready')return
  registerSleepGuard(file.id,async canDispose=>{
   if(!live.current||!session.current()||!canDispose?.())return false
   try{
    const editor=frame.current?.contentWindow as EditorWindow|null
    // Dispose checks dirty and pending work without invoking the close prompt.
    if(!editor||editor.document.fullscreenElement||!editor.dyofficeEditorDispose||editor.dyofficeEditorCanSleep?.()===false)return false
    return await editor.dyofficeEditorDispose()
   }catch{return false}
  })
  return()=>registerSleepGuard(file.id,null)
 },[file.id,registerSleepGuard,failed,loadingState])
 return <div className="document-loading-host">{!failed&&loadingState!=='ready'&&<DocumentLoading key={attempt} name={file.name} format={file.format} state={loadingState} onRetry={()=>{void retryEditor()}}/>}{failed&&<Alert role="alert" type="error" title="编辑器加载失败" description="请重新加载编辑器，或关闭此文档页签后再打开。" action={<Button onClick={retry}>重新加载编辑器</Button>}/>}<div className="document-loading-content" data-loading={!failed&&loadingState!=='ready'} aria-busy={!failed&&loadingState!=='ready'}><iframe key={attempt} ref={bindFrame} data-document-id={file.id} src={source} title={file.name} allow={file.format==='pptx'?'display-capture; fullscreen':undefined} onLoad={loaded} className="workspace-document-frame" hidden={failed} style={failed?{display:'none'}:undefined}/></div></div>
}
