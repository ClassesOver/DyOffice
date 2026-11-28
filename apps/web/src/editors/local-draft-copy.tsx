import {useEffect,useRef,useState} from 'react'
import type {DocsEditorHandle} from '../../../docs/src/renderer/file-actions'
import type {DraftCopyAuthority} from './draft-copy-authority'
type DraftEditor=Pick<DocsEditorHandle,'serialize'>
type SealDraft=(bytes:Uint8Array)=>Promise<Uint8Array>
const copyText={
 zh:{encryptedHint:'使用此标签页最后确认的打开密码加密草稿并下载。下载不会提交工作区修订。',button:'下载未保存草稿副本',working:'正在生成草稿副本…',hint:'仅下载当前草稿，不保存到服务器，也不会清除未保存或待确认状态。',requested:'已发起草稿副本下载。确认本地副本后再关闭；下载之后的编辑可能未包含。服务器保存状态没有改变。',failed:'草稿副本未下载。当前草稿及待确认状态已保留，请勿关闭页面。'},
 en:{encryptedHint:'Download the draft encrypted with this tab’s last confirmed open password. This leaves the workspace revision as saved.',button:'Download unsaved draft copy',working:'Preparing draft copy…',hint:'Local draft copy only. This does not save to the server or clear unsaved or unconfirmed state.',requested:'Draft download requested. Confirm the local copy before closing; later edits may not be included. Server save status is unchanged.',failed:'Draft copy was not downloaded. Your draft and unconfirmed state are preserved; keep this page open.'},
}
function filename(name:string){
 const stem=name.replace(/\.docx$/i,'').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,' ').replace(/^\.+|\.+$/g,'').trim().slice(0,80)||'document'
 return `${stem}-unsaved-draft.docx`
}
/** No host save/lease/reconcile capability: only an explicitly requested local snapshot. */
export function LocalDraftCopy({name,locale,getEditor,authority,seal}:{name:string;locale:'zh'|'en';getEditor():DraftEditor|null;authority:DraftCopyAuthority;seal?:SealDraft}){
 const [state,setState]=useState<'idle'|'working'|'requested'|'failed'>('idle')
 const mounted=useRef(true),busy=useRef(false),current=useRef({name,getEditor,authority,seal})
 current.current={name,getEditor,authority,seal}
 const releases=useRef(new Map<string,ReturnType<typeof setTimeout>>())
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const [url,timer] of releases.current){clearTimeout(timer);URL.revokeObjectURL(url)}releases.current.clear()}},[])
 const text=copyText[locale],hint=seal?text.encryptedHint:text.hint
 async function copy(){
  if(!mounted.current||busy.current)return
  const access=current.current.authority,editor=current.current.getEditor(),protect=current.current.seal,downloadName=filename(current.current.name)
  const active=()=>mounted.current&&current.current.authority===access&&access.current()&&current.current.getEditor()===editor&&current.current.seal===protect
  if(!editor){setState('failed');return}
  busy.current=true;setState('working')
  try{
   if(!await access.verify()||!active())throw Error('inactive')
   const draft=await editor.serialize()
   if(!active()||!await access.verify()||!active()||!(draft instanceof Uint8Array)||!draft.byteLength||draft.byteLength>32*1024*1024)throw Error('snapshot unavailable')
   const bytes=protect?await protect(draft):draft
   if((protect&&!await access.verify())||!active())throw Error('inactive')
   const blob=new Blob([bytes.slice().buffer as ArrayBuffer],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})
   const url=URL.createObjectURL(blob),link=document.createElement('a')
   try{
    const timer=setTimeout(()=>{URL.revokeObjectURL(url);releases.current.delete(url)},30_000)
    releases.current.set(url,timer)
    link.href=url;link.download=downloadName;link.rel='noopener';link.hidden=true;document.body.append(link);link.click()
   }catch(error){clearTimeout(releases.current.get(url));releases.current.delete(url);URL.revokeObjectURL(url);throw error}
   finally{link.remove()}
   // A browser click is not confirmation that a file reached durable local storage.
   if(mounted.current)setState('requested')
  }catch{if(mounted.current)setState('failed')}
  finally{busy.current=false}
 }
 return <><button type="button" className="dyoffice-docs-draft-copy" title={hint} disabled={state==='working'||!getEditor()||!authority.current()} onClick={event=>{event.stopPropagation();void copy()}}>{state==='working'?text.working:text.button}</button><span className="dyoffice-docs-draft-copy-status" role="status">{state==='requested'?text.requested:state==='failed'?text.failed:hint}</span></>
}
