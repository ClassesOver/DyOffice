import {useEffect,useRef,useState} from 'react'
import type {createAnalysisDeliveryClient} from '../../../../packages/browser-host/src/analysis-delivery-client.ts'
import {withAnalysisProvenance} from '../../../../packages/browser-host/src/analysis-insert-provenance.ts'
import {prepareAnalysisInsertContent} from '../../../../packages/browser-host/src/analysis-insert-content.ts'
import type {createAnalysisDocumentRegistry} from '../../../../packages/browser-host/src/analysis-document-registry.ts'
import type {AnalysisDocumentTarget} from '../../../../packages/web-contracts/src/analysis-document.ts'
import './analysis-delivery-panel.css'
type Client=ReturnType<typeof createAnalysisDeliveryClient>
function offerDownload(file:Awaited<ReturnType<Client['download']>>) {
 if(!file.current())return
 const url=URL.createObjectURL(new Blob([file.bytes],{type:'application/octet-stream'}))
 try {if(!file.current())return;const link=document.createElement('a');link.href=url;link.download=file.name;link.click()}
 finally{setTimeout(()=>URL.revokeObjectURL(url),0)}
}
type Applied={target:AnalysisDocumentTarget;applicationId:string;commandId:string;artifactId:string;sha256:string;baseRevision:string;state:'applied'|'saved'|'unknown';revision?:string}
export function AnalysisDeliveryPanel({client,lang,documents}:{client:Client;lang:'en'|'zh';documents?:Pick<ReturnType<typeof createAnalysisDocumentRegistry>,'current'|'subscribe'>}) {
 const [items,setItems]=useState(()=>client.snapshot()),[error,setError]=useState(()=>client.error()),[busy,setBusy]=useState('')
 const generation=useRef(0),busyRef=useRef<symbol|null>(null),currentClient=useRef(client),currentDocuments=useRef(documents)
 currentClient.current=client;currentDocuments.current=documents
 const [target,setTarget]=useState(()=>documents?.current()),[applied,setApplied]=useState<Record<string,Applied>>({}),[notice,setNotice]=useState(''),[blocked,setBlocked]=useState<Set<string>>(()=>new Set())
 useEffect(()=>{generation.current++;busyRef.current=null;setBusy('');setApplied({});setBlocked(new Set());setNotice('');const update=()=>{setItems(client.snapshot());setError(client.error());if(client.error()){setApplied({});setNotice('')}};update();const off=client.subscribe(update),focus=()=>void client.refresh();window.addEventListener('focus',focus);return()=>{generation.current++;off();window.removeEventListener('focus',focus)}},[client])
 useEffect(()=>{generation.current++;busyRef.current=null;setBusy('');let selected=documents?.current();setTarget(selected);setApplied({});setBlocked(new Set());setNotice('');const update=()=>{const next=documents?.current();if(next!==selected){selected=next;generation.current++;busyRef.current=null;setBusy('');setApplied({});setBlocked(new Set());setNotice('');setTarget(next)}};const off=documents?.subscribe(update);return()=>{generation.current++;off?.()}},[documents])
 const en=lang==='en',key=(commandId:string,artifactId:string)=>commandId+':'+artifactId
 const begin=(id:string)=>{if(busyRef.current)return;const token=Symbol();busyRef.current=token;setBusy(id);return token}
 const finish=(token:symbol)=>{if(busyRef.current===token){busyRef.current=null;setBusy('')}}
 const active=(stamp:number)=>generation.current===stamp&&currentClient.current===client&&currentDocuments.current===documents
 async function download(commandId:string,artifactId:string){const token=begin(artifactId);if(!token)return;const stamp=generation.current;try{const file=await client.download(commandId,artifactId);if(active(stamp)&&file.current())offerDownload(file)}catch{if(active(stamp))setError(en?'Download could not be confirmed. Reopen the assistant.':'无法确认下载，请重新打开助手。')}finally{if(active(stamp))finish(token)}}
 async function insert(commandId:string,artifactId:string){
  const id=key(commandId,artifactId),selected=documents?.current();if(!selected||applied[id]||blocked.has(id))return
  const token=begin(artifactId);if(!token)return;const stamp=generation.current
  try{
   const capture=selected.capture() // Capture selection/revision before any await.
   if(capture.fileId!==selected.fileId||capture.format!==selected.format)throw Error()
   const file=await client.download(commandId,artifactId)
   const authorized=()=>active(stamp)&&documents?.current()===selected&&file.current()
   if(!authorized()||file.artifact.artifactId!==artifactId)throw Error()
   const content=withAnalysisProvenance(prepareAnalysisInsertContent({...file.artifact,bytes:file.bytes}),file.receipt,file.artifact,capture.format)
   if(!authorized())throw Error()
   setBlocked(old=>new Set(old).add(id))
   const result=await selected.apply(capture,content,{artifactId,sha256:file.artifact.sha256},authorized)
   if(!authorized())throw Error()
   if(result.status!=='applied_uncommitted'||typeof result.applicationId!=='string'||!result.applicationId||result.applicationId.length>200)throw Error()
   setApplied(old=>({...old,[id]:{target:selected,applicationId:result.applicationId,commandId,artifactId,sha256:file.artifact.sha256,baseRevision:capture.baseRevision,state:'applied'}}));setNotice(en?'Applied, not saved':'已插入，尚未保存')
  }catch{if(active(stamp))setNotice(en?'Insertion not confirmed. Check the document before retrying.':'插入结果未确认，请先核对文档，勿重复提交。')}
  finally{if(active(stamp))finish(token)}
 }
 async function save(id:string){
  const entry=applied[id];if(!entry||entry.state!=='applied'||documents?.current()!==entry.target)return
  const token=begin(entry.artifactId);if(!token)return;const stamp=generation.current
  // Never automatically repeat an ambiguous save.
  setApplied(old=>({...old,[id]:{...entry,state:'unknown'}}))
  try{
   const authorization=await client.authorize(entry.commandId,entry.artifactId)
   const authorized=()=>active(stamp)&&documents?.current()===entry.target&&authorization.current()
   if(!authorized()||authorization.artifact.artifactId!==entry.artifactId||authorization.artifact.sha256!==entry.sha256)throw Error()
   const result=await entry.target.save(entry.applicationId,authorized)
   if(!authorized())throw Error()
   if(result.status!=='saved'||result.applicationId!==entry.applicationId||result.receipt.fileId!==entry.target.fileId||typeof result.receipt.revision!=='string'||!result.receipt.revision||result.receipt.revision.length>256||result.receipt.revision===entry.baseRevision||!/^[a-f0-9]{64}$/.test(result.receipt.sha256)||!Number.isSafeInteger(result.receipt.size)||result.receipt.size<0)throw Error()
   setApplied(old=>({...old,[id]:{...entry,state:'saved',revision:result.receipt.revision}}));setNotice(en?'Saved revision: '+result.receipt.revision:'已保存版本：'+result.receipt.revision)
  }catch{if(active(stamp))setNotice(en?'Save not confirmed. Check the document before retrying.':'保存结果未确认，请先核对文档，勿重复提交。')}
  finally{if(active(stamp))finish(token)}
 }
 const insertable=(file:{role:string;mediaType:string})=>target&&((file.role==='report'&&['text/plain','text/markdown'].includes(file.mediaType))||(target.format!=='pdf'&&file.role==='table'&&file.mediaType==='text/csv'))
 const insertLabel=target?.format==='pdf'?(en?'Append to PDF':'追加到 PDF'):target?.format==='pptx'?(en?'Insert into current slide':'插入当前幻灯片'):target?.format==='xlsx'?(en?'Write to selection':'写入当前选区'):(en?'Insert into document':'插入文档')
 return <details className="analysis-deliveries" onToggle={event=>{if(event.currentTarget.open)void client.restore()}}><summary>{en?'Analysis deliveries':'分析交付'} ({items.length})</summary>
  <p>{en?'Server-confirmed references and file integrity, not verified conclusions. Automatically generated content remains unverified. Committed does not mean inserted into or saved in your document. Supported text and CSV may be inserted only on request; saving is separate.':'服务端仅确认提交记录与文件完整性，不保证结论正确。自动生成内容尚未核验；已提交不代表已插入或保存到文档。支持的文本与CSV仅在明确操作后插入，保存需单独确认；文件不执行或预览。'}</p>
  {target&&target.format!=='pdf'&&<p>{target.format==='pptx'?(en?'Insert native text or a table on the current slide. Changes are not saved; Undo is available.':'在当前幻灯片插入原生文本或表格。尚未保存，可撤销。'):target.format==='xlsx'?(en?'Write from the top-left of the current selection and overwrite the destination cells. Changes are not saved; Undo is available.':'从当前选区左上角写入并覆盖目标单元格。尚未保存，可撤销。'):(en?'Insert after the current paragraph. Changes are not saved; Undo is available.':'在当前段落后插入。尚未保存，可撤销。')}</p>}
  {notice&&<p role="status">{notice}</p>}
  {error&&<p role="alert">{en?'Cannot confirm analysis delivery or session. Reopen the assistant.':error}</p>}
  {!items.length&&!error&&<p>{en?'No confirmed analysis deliveries.':'暂无已确认的分析交付。'}</p>}
  {items.map(({agent,receipt})=><section key={receipt.commandId} className="analysis-delivery">
   <h4>{agent?`${agent.name} · ${en?(agent.origin==='builtin'?'Built-in':'External'):(agent.origin==='builtin'?'内置':'外部')}`:(en?'Previous delivery':'历史交付')}</h4>
   <p className="analysis-untrusted">{en?'Untrusted analysis':'不可信分析内容'}</p><p>{receipt.summary}</p>
   <ul>{receipt.artifacts.map(file=><li key={file.artifactId}><span>{file.name} · {file.role} · {file.sizeBytes} B · {file.mediaType}</span><button type="button" disabled={!!busy} onClick={()=>void download(receipt.commandId,file.artifactId)}>{busy===file.artifactId?(en?'Checking…':'校验中…'):(en?'Download':'下载')}</button>{insertable(file)&&!applied[key(receipt.commandId,file.artifactId)]&&!blocked.has(key(receipt.commandId,file.artifactId))&&<button type="button" disabled={!!busy} onClick={()=>void insert(receipt.commandId,file.artifactId)}>{insertLabel}</button>}{applied[key(receipt.commandId,file.artifactId)]?.state==='applied'&&<button type="button" disabled={!!busy} onClick={()=>void save(key(receipt.commandId,file.artifactId))}>{en?'Save document':'保存文档'}</button>}<p>{en?'File byte SHA-256':'文件字节 SHA-256'}: <code>{file.sha256}</code></p></li>)}</ul>
   <h5>{en?'Inputs and scope':'输入与范围'}</h5><ul>{receipt.inputs.map(input=><li key={input.resultId}>{input.sourceId} · v{input.sourceVersion} · {input.rowCount} {en?'rows':'行'}{input.truncated&&<strong className="analysis-truncated"> {en?'TRUNCATED: not the full dataset':'已截断：不是全量数据'}</strong>}<p>{en?'Timezone: ':'时区：'}{input.timezone??(en?'not recorded':'未记录')}</p>{input.schema?<ul>{input.schema.map(column=><li key={column.name}>{column.name} · {column.type} · {en?'Unit: ':'单位：'}{column.unit??(en?'not recorded':'未记录')}</li>)}</ul>:<p>{en?'Column types and units: not recorded':'列类型及单位：未记录'}</p>}<p>{en?'Frozen result':'冻结结果'}: <code>{input.resultId}</code></p><p>{en?'Snapshot SHA-256':'快照 SHA-256'}: <code>{input.sha256}</code></p><p>{en?'Query SHA-256':'查询 SHA-256'}: <code>{input.queryHash}</code></p></li>)}</ul>
   <h5>{en?'Limitations':'限制说明'}</h5>{receipt.limitations.length?<ul>{receipt.limitations.map((line,i)=><li key={i}>{line}</li>)}</ul>:<p>{en?'No limitations supplied; this is not a guarantee of completeness.':'未提供限制说明，不代表结论完整。'}</p>}
   <p>{en?'Runtime manifest SHA-256':'运行环境清单 SHA-256'}: <code>{receipt.runtimeManifestSha256}</code></p><p>{en?'Commit receipt':'提交收据'}: <code>{receipt.commandId}</code></p>
  </section>)}
 </details>
}
