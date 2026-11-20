import {useEffect,useState} from 'react'
import type {DocumentFormat} from '../shell/document-tabs'
import type {DocumentLoadingState} from './document-loading-state'
import './document-loading.css'

export function DocumentLoading({name,format,state,onRetry}:{name:string;format:DocumentFormat;state:DocumentLoadingState;onRetry?:()=>void}) {
 const [slow,setSlow]=useState(false)
 useEffect(()=>{const timer=setTimeout(()=>setSlow(true),8000);return()=>clearTimeout(timer)},[])
 const english=document.documentElement.lang.startsWith('en'),failed=state==='error'
 const status=failed?(english?'Unable to open document':'文档打开失败'):state==='rendering'?(english?'Preparing pages…':'正在准备页面…'):(english?'Reading document…':'正在读取文档…')
 return <div className="document-loading" data-format={format} data-state={state}>
  <div className="document-loading-card" role={failed?'alert':'status'} aria-live="polite">
   <span className="document-loading-icon" aria-hidden="true">{format==='docx'?'W':format==='xlsx'?'X':format==='pptx'?'P':'PDF'}</span>
   <strong className="document-loading-name" title={name}>{name}</strong>
   <span className="document-loading-status">{status}</span>
   {!failed&&<><div className="document-loading-track" aria-hidden="true"><span/></div><div className="document-loading-skeleton" aria-hidden="true"><i/><i/><i/></div></>}
   <p className="document-loading-hint">{failed?(english?'Your file is preserved. You can try opening it again.':'文件仍保留，可以重新尝试打开。'):slow?(english?'Still loading. Larger files may take a little longer.':'仍在加载，较大的文件可能需要更多时间。'):(english?'Getting your workspace ready':'正在为你准备工作区')}</p>
   {failed&&onRetry&&<button type="button" onClick={onRetry}>{english?'Try again':'重新加载编辑器'}</button>}
  </div>
 </div>
}
