import {useEffect,useRef,useState} from 'react'
import type {createAnalysisDeliveryClient} from '../../../../packages/browser-host/src/analysis-delivery-client.ts'
import './analysis-delivery-panel.css'
type Client=ReturnType<typeof createAnalysisDeliveryClient>
function offerDownload(file:Awaited<ReturnType<Client['download']>>) {
 if(!file.current())return
 const url=URL.createObjectURL(new Blob([file.bytes],{type:'application/octet-stream'}))
 try {if(!file.current())return;const link=document.createElement('a');link.href=url;link.download=file.name;link.click()}
 finally{setTimeout(()=>URL.revokeObjectURL(url),0)}
}
export function AnalysisDeliveryPanel({client,lang}:{client:Client;lang:'en'|'zh'}) {
 const [items,setItems]=useState(()=>client.snapshot()),[error,setError]=useState(()=>client.error()),[busy,setBusy]=useState('')
 const generation=useRef(0)
 useEffect(()=>{const stamp=++generation.current;setBusy('');const update=()=>{setItems(client.snapshot());setError(client.error())};update();const off=client.subscribe(update),focus=()=>void client.refresh();window.addEventListener('focus',focus);return()=>{if(generation.current===stamp)generation.current++;off();window.removeEventListener('focus',focus)}},[client])
 const en=lang==='en'
 async function download(commandId:string,artifactId:string){if(busy)return;const stamp=generation.current;setBusy(artifactId);try{const file=await client.download(commandId,artifactId);if(generation.current===stamp&&file.current())offerDownload(file)}catch{if(generation.current===stamp)setError(en?'Download could not be confirmed. Reopen the assistant.':'无法确认下载，请重新打开助手。')}finally{if(generation.current===stamp)setBusy('')}}
 return <details className="analysis-deliveries" onToggle={event=>{if(event.currentTarget.open)void client.refresh()}}><summary>{en?'Analysis deliveries':'分析交付'} ({items.length})</summary>
  <p>{en?'Server-confirmed references and file integrity, not verified conclusions. Automatically generated content remains unverified. Committed does not mean inserted into or saved in your document. Files are downloads only.':'服务端仅确认提交记录与文件完整性，不保证结论正确。自动生成内容尚未核验；已提交不代表已插入或保存到文档。文件仅下载，不执行或预览。'}</p>
  {error&&<p role="alert">{en?'Cannot confirm analysis delivery or session. Reopen the assistant.':error}</p>}
  {!items.length&&!error&&<p>{en?'No confirmed analysis deliveries in this assistant session.':'当前助手会话暂无已确认的分析交付。'}</p>}
  {items.map(({agent,receipt})=><section key={receipt.commandId} className="analysis-delivery">
   <h4>{agent.name} · {en?(agent.origin==='builtin'?'Built-in':'External'):(agent.origin==='builtin'?'内置':'外部')}</h4>
   <p className="analysis-untrusted">{en?'Untrusted analysis':'不可信分析内容'}</p><p>{receipt.summary}</p>
   <ul>{receipt.artifacts.map(file=><li key={file.artifactId}><span>{file.name} · {file.role} · {file.sizeBytes} B · {file.mediaType}</span><button type="button" disabled={!!busy} onClick={()=>void download(receipt.commandId,file.artifactId)}>{busy===file.artifactId?(en?'Checking…':'校验中…'):(en?'Download':'下载')}</button><p>{en?'File byte SHA-256':'文件字节 SHA-256'}: <code>{file.sha256}</code></p></li>)}</ul>
   <h5>{en?'Inputs and scope':'输入与范围'}</h5><ul>{receipt.inputs.map(input=><li key={input.resultId}>{input.sourceId} · v{input.sourceVersion} · {input.rowCount} {en?'rows':'行'}{input.truncated&&<strong className="analysis-truncated"> {en?'TRUNCATED: not the full dataset':'已截断：不是全量数据'}</strong>}<p>{en?'Frozen result':'冻结结果'}: <code>{input.resultId}</code></p><p>{en?'Snapshot SHA-256':'快照 SHA-256'}: <code>{input.sha256}</code></p><p>{en?'Query SHA-256':'查询 SHA-256'}: <code>{input.queryHash}</code></p></li>)}</ul>
   <h5>{en?'Limitations':'限制说明'}</h5>{receipt.limitations.length?<ul>{receipt.limitations.map((line,i)=><li key={i}>{line}</li>)}</ul>:<p>{en?'No limitations supplied; this is not a guarantee of completeness.':'未提供限制说明，不代表结论完整。'}</p>}
   <p>{en?'Runtime manifest SHA-256':'运行环境清单 SHA-256'}: <code>{receipt.runtimeManifestSha256}</code></p><p>{en?'Commit receipt':'提交收据'}: <code>{receipt.commandId}</code></p>
  </section>)}
 </details>
}
