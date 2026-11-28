import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import {isRevisionRef,type OfficeFormat,type RevisionRef} from '../../../../packages/web-contracts/src/api'
import type {RedactionInput} from '../../../pdf/src/shared/ipc'

export type PdfRedactedCopy={patterns:readonly string[];ids:readonly string[]}|{regions:readonly RedactionInput[]}
export type PdfPageLayout={kind:'split';perPage:2|4|9}|{kind:'merge';perSheet:number;direction:'horizontal'|'vertical';separator:boolean}

export const MAX_WORKSPACE_COPY_BYTES=32*1024*1024
type PdfCopyDestination={name:string;folderId?:string}
type PublicationDestination=PdfCopyDestination&{format?:OfficeFormat}
type Prepared={uploadId:string;fileId:string;sha256:string;size:number;receipt?:RevisionRef;delivered?:boolean;expired?:boolean}
type PresentCopy=(receipt:RevisionRef,signal?:AbortSignal)=>Promise<void>
type PendingCopies={files:Prepared[];revealBatch?:PresentCopy;delivery?:'open'|'save';format?:OfficeFormat}
/** Recovery resumes the same ordered uploads without regenerating the PDFs. */
export function createPdfExtraction({fileId,name,request,getRevision,onCreated,onSaved,onBatchPublished}:{fileId:string;name:string;request:SettingsRequest;getRevision:()=>string;onCreated:PresentCopy;onSaved?:PresentCopy;onBatchPublished?:PresentCopy}){
 let busy=false,stageUnknown=false,pending:PendingCopies|undefined
 let progress={created:0,total:0}
 let receipts:RevisionRef[]=[]
 const remove=async(uploadId:string)=>{await request(`/api/v1/uploads/${encodeURIComponent(uploadId)}`,'DELETE').catch(()=>{})}
 const updateProgress=()=>{if(pending)progress={created:pending.files.filter(item=>!!item.receipt).length,total:pending.files.length}}
 async function finish(signal?:AbortSignal){
  const {files:queue,revealBatch,delivery,format='pdf'}=pending!
  const present=delivery==='save'?onSaved:onCreated
  for(const current of queue){
   signal?.throwIfAborted()
   if(current.delivered||current.expired)continue
   if(!current.receipt){
    let result:{format:string;file:RevisionRef}
    try{result=await request(`/api/v1/uploads/${encodeURIComponent(current.uploadId)}/finish`,'POST',undefined,signal)}
    catch(error){
     // 只有 410 证明上传在发布前过期；409 也可能在发布后因授权版本变化返回。
     if((error as {status?:number})?.status===410){
      current.expired=true;await remove(current.uploadId)
      if(queue.length===1)pending=undefined
     }
     throw error
    }
    if(result?.format!==format||!isRevisionRef(result.file)||result.file.fileId!==current.fileId||result.file.sha256!==current.sha256||result.file.size!==current.size)throw Error('无法核对副本的保存回执，请保留页面确认结果，不要重复生成。')
    current.receipt={...result.file};updateProgress()
   }
   signal?.throwIfAborted()
   const receipt=current.receipt
   const confirmed=await request<RevisionRef>(`/api/v1/files/${encodeURIComponent(receipt.fileId)}/revisions/${encodeURIComponent(receipt.revision)}`,undefined,undefined,signal)
   if(!isRevisionRef(confirmed)||confirmed.fileId!==receipt.fileId||confirmed.revision!==receipt.revision||confirmed.sha256!==receipt.sha256||confirmed.size!==receipt.size)throw Error('无法核对副本的保存回执，请保留页面确认结果，不要重复生成。')
   signal?.throwIfAborted()
   if(!revealBatch&&present){
    try{await present(receipt,signal)}catch{
     throw Error(delivery==='save'
      ?'副本已保存，但文件列表刷新失败。请确认结果以重试刷新。'
      :'副本已创建，但打开失败。请从文件列表打开，或确认结果重试打开，不要重复生成。')
    }
   }
   current.delivered=true
   receipts.push({...receipt})
   signal?.throwIfAborted()
  }
  const partial=queue.some(item=>item.expired)
  if(!partial&&revealBatch){
   try{await revealBatch(receipts[0]!,signal)}catch{throw Error('PDF 拆分文件已保存，但无法定位文件夹。请确认结果以重试定位。')}
  }
  pending=undefined
  if(partial)throw Error(`仅生成 ${progress.created}/${progress.total} 份 PDF，其余上传已过期，未全部完成。`)
  return true
 }
 async function prepare(kind:'extract'|'split'|'layout'|'redact',input:readonly number[]|number|PdfPageLayout|PdfRedactedCopy,signal?:AbortSignal,destination?:PdfCopyDestination){
  signal?.throwIfAborted()
  if(busy||pending||!getRevision())return false
  if(stageUnknown)throw Error('上次 PDF 副本准备结果未确认，尚未发布新文件。请重新加载工作区后核对，不要自动重复生成。')
  if(kind==='split'&&(!Number.isSafeInteger(input)||Number(input)<1))throw Error('Invalid PDF split size')
  busy=true;progress={created:0,total:0};receipts=[]
  let leaseEpoch:number|undefined,stageStarted=false,finishStarted=false
  const editorId=crypto.randomUUID(),baseRevision=getRevision()
  try{
   const lease=await request<{leaseEpoch:number}>(`/api/v1/files/${fileId}/lease`,'POST',{editorId},signal)
   leaseEpoch=lease.leaseEpoch;signal?.throwIfAborted()
   stageStarted=true
   const operation=kind==='redact'
    ?{...(input as PdfRedactedCopy),name:`${name.replace(/\.pdf$/i,'').slice(0,100)}-涂黑副本.pdf`}
    :kind==='layout'?{operation:input}
    :kind==='split'?{pagesPerFile:input}
    :{pages:input,name:`${name.replace(/\.pdf$/i,'').slice(0,100)}-提取.pdf`}
   const endpoint=kind==='split'?'split':kind==='layout'?'page-layout':kind==='redact'?'redacted-copy':'extract-pages'
   const result=await request<Prepared|{files:Prepared[]}>(`/api/v1/files/${fileId}/pdf/${endpoint}/uploads`,'POST',{
    baseRevision,editorId,leaseEpoch,...operation,...destination,
   },signal)
   const files=kind==='split'?(result as {files:Prepared[]})?.files:[result as Prepared]
   if(!Array.isArray(files)||files.length<(kind==='split'?2:1)||files.length>100||files.some(item=>!item||typeof item.uploadId!=='string'||!item.uploadId||item.fileId===fileId||!isRevisionRef({...item,revision:'prepared'}))||new Set(files.map(item=>item.uploadId)).size!==files.length||new Set(files.map(item=>item.fileId)).size!==files.length)throw Error('Invalid PDF extraction preparation')
   pending={files:files.map(({uploadId,fileId,sha256,size})=>({uploadId,fileId,sha256,size})),revealBatch:kind==='split'&&destination?onBatchPublished:undefined};updateProgress()
   signal?.throwIfAborted()
   finishStarted=true
   return await finish(signal)
  }catch(error){
   if(!finishStarted){
    if(pending){for(const item of pending.files)await remove(item.uploadId);pending=undefined}
    else if(stageStarted){const status=(error as {status?:number})?.status;stageUnknown=status===undefined||status>=500||[408,429].includes(status)}
   }
   throw error
  }finally{
   if(leaseEpoch!==undefined)await request(`/api/v1/files/${fileId}/lease`,'DELETE',{editorId,leaseEpoch}).catch(()=>{})
   busy=false
  }
 }
 return {
  hasPending:()=>!!pending,
  getProgress:()=>({...progress}),
  getReceipts:()=>receipts.map(receipt=>({...receipt})),
  async confirm(signal?:AbortSignal){
   if(busy||!pending)return false
   busy=true
   try{return await finish(signal)}finally{busy=false}
  },
  async publish(bytes:Uint8Array<ArrayBuffer>,{format='pdf',...destination}:PublicationDestination,active:()=>boolean,signal?:AbortSignal,delivery:'open'|'save'='open'){
   const check=()=>{
    signal?.throwIfAborted()
    if(!active())throw Error('Copy authorization changed.')
   }
   check()
   if(busy||pending||stageUnknown)return false
   if(!bytes.byteLength||bytes.byteLength>MAX_WORKSPACE_COPY_BYTES)throw Error('Invalid copy size.')
   busy=true;progress={created:0,total:0};receipts=[]
   let uploadId:string|undefined,finishStarted=false
   try{
    const digest=await crypto.subtle.digest('SHA-256',bytes)
    const sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
    check()
    const stage=await request<{fileId:string;uploadId:string}>('/api/v1/files/uploads','POST',{
     ...destination,size:bytes.byteLength,
    },signal)
    if(typeof stage?.uploadId==='string'&&stage.uploadId)uploadId=stage.uploadId
    if(!uploadId||typeof stage.fileId!=='string'||!stage.fileId||fileId===stage.fileId)throw Error('Invalid copy upload.')
    check()
    await request(`/api/v1/uploads/${encodeURIComponent(uploadId)}/content`,'PUT',new Blob([bytes]),signal)
    check()
    pending={files:[{uploadId,fileId:stage.fileId,sha256,size:bytes.byteLength}],delivery,format};updateProgress()
    finishStarted=true
    return await finish(signal)
   }catch(error){
    if(uploadId&&!finishStarted)await remove(uploadId)
    throw error
   }finally{busy=false}
  },
  redact:(input:PdfRedactedCopy,signal?:AbortSignal)=>prepare('redact',input,signal),
  extract:(pages:readonly number[],signal?:AbortSignal,name?:string)=>prepare('extract',pages,signal,name?{name}:undefined),
  split:(pagesPerFile:number,signal?:AbortSignal,destination?:PdfCopyDestination)=>prepare('split',pagesPerFile,signal,destination),
  layout:(operation:PdfPageLayout,signal?:AbortSignal,name?:string)=>prepare('layout',operation,signal,name?{name}:undefined),
 }
}
