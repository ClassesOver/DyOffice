import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {SaveInput,RevisionRef} from '../../../../packages/web-contracts/src/api'

type Receipt=RevisionRef
export function createPdfMutations({fileId,request,getRevision,onSaved,editGrantId}:{fileId:string;editGrantId?:string|undefined;request:SettingsRequest;getRevision:()=>string;onSaved:(receipt:Receipt)=>Promise<void>}){
 let busy=false
 let pending:{input:SaveInput;editorId:string}|undefined
 const release=async(editorId:string,leaseEpoch:number)=>{await request(`/api/v1/files/${fileId}/lease`,'DELETE',{editorId,leaseEpoch}).catch(()=>{})}
 async function commit(signal?:AbortSignal,recovering=false){
  const current=pending!
  let receipt:Receipt
  try{receipt=await request<Receipt>(`/api/v1/files/${fileId}/commits`,'POST',current.input,signal)}
  catch(error){
   const status=(error as {status?:number})?.status
   // 授权复核可能在提交成功后失败，保留同一输入恢复；409 由回执优先检查确认拒绝。
   const rejected=recovering?status===409:status===400||status===409
   if(rejected){
    pending=undefined
    await request(`/api/v1/uploads/${current.input.uploadId}`,'DELETE').catch(()=>{})
    await release(current.editorId,current.input.leaseEpoch)
   }
   throw error
  }
  if(receipt.fileId!==fileId||typeof receipt.revision!=='string'||!receipt.revision)throw Error('Invalid PDF revision receipt')
  pending=undefined
  await release(current.editorId,current.input.leaseEpoch)
  await onSaved(receipt)
  return true
 }
 return {
  hasPending:()=>!!pending,
  async confirm(){
   if(busy||!pending)return false
   busy=true
   try{return await commit(undefined,true)}finally{busy=false}
  },
 async mutate(action:'rotate'|'edit-text'|'annotate'|'delete-annotations'|'update-notes'|'page-ops'|'form-values'|'form-fields'|'text-inserts'|'block-edits'|'block-moves'|'image-edits'|'image-content'|'image-bakes'|'stamps'|'replace-pages'|'insert-pages'|'draft-inserts'|'apply-ops',operations:readonly unknown[],signal?:AbortSignal,check=()=>true){
   signal?.throwIfAborted()
   if(busy||pending||!check()||!getRevision()||['image-content','image-bakes','stamps','draft-inserts','apply-ops'].includes(action)&&operations.length!==1)return false
   const snapshot=action==='apply-ops'?structuredClone(operations[0]) as {fileId?:string;baseRevision?:string}|undefined:undefined
   if(action==='apply-ops'&&(!snapshot||snapshot.fileId!==fileId||snapshot.baseRevision!==getRevision()))return false
   const replacement=action==='replace-pages'?operations[0] as {pages:readonly number[];source:Blob}|undefined:undefined
   if(action==='replace-pages'&&(operations.length!==1||!(replacement?.source instanceof Blob)||replacement.source.size<1||replacement.source.size>64*1024*1024||!Array.isArray(replacement.pages)||!replacement.pages.length||replacement.pages.length>100||new Set(replacement.pages).size!==replacement.pages.length||replacement.pages.some(page=>!Number.isSafeInteger(page)||page<1||page>100)))return false
   const insertion=action==='insert-pages'?operations[0] as {afterPageIndex:number;source:Blob}|undefined:undefined
   if(action==='insert-pages'&&(operations.length!==1||!(insertion?.source instanceof Blob)||insertion.source.size<1||insertion.source.size>64*1024*1024||!Number.isSafeInteger(insertion.afterPageIndex)||insertion.afterPageIndex< -1||insertion.afterPageIndex>=100))return false
   busy=true
   const editorId=editGrantId??crypto.randomUUID(),baseRevision=getRevision()
   let leaseEpoch:number|undefined,commitStarted=false
   try{
    const lease=await request<{leaseEpoch:number}>(`/api/v1/files/${fileId}/lease`,'POST',{editorId},signal)
    leaseEpoch=lease.leaseEpoch
    signal?.throwIfAborted()
    if(!check())throw Error('PDF save authorization changed')
    const path=action==='rotate'?'uploads':`${action}/uploads`
    const idempotencyKey=crypto.randomUUID()
    const endpoint=`/api/v1/files/${fileId}/pdf/${path}`
    const metadata={baseRevision,editorId,leaseEpoch,idempotencyKey}
    const prepared=await request<{commitInput?:SaveInput;uploadId?:string}>(replacement?`${endpoint}?${new URLSearchParams({...metadata,leaseEpoch:String(leaseEpoch),pages:JSON.stringify(replacement.pages)})}`:insertion?`${endpoint}?${new URLSearchParams({...metadata,leaseEpoch:String(leaseEpoch),afterPageIndex:String(insertion.afterPageIndex)})}`:endpoint,'POST',replacement?.source??insertion?.source??{...metadata,...(action==='apply-ops'?{snapshot}:['image-content','image-bakes','stamps','draft-inserts'].includes(action)?{operation:operations[0]}:{operations})},signal)
    const input=prepared.commitInput??(action==='rotate'?{fileId,uploadId:prepared.uploadId!,baseRevision,leaseEpoch,idempotencyKey}:undefined)
    if(!input||input.fileId!==fileId||input.baseRevision!==baseRevision||input.leaseEpoch!==leaseEpoch||typeof input.uploadId!=='string'||typeof input.idempotencyKey!=='string')throw Error('Invalid PDF save preparation')
    pending={input,editorId}
    signal?.throwIfAborted()
    if(!check())throw Error('PDF save authorization changed')
    commitStarted=true
    return await commit(signal)
   }catch(error){
    if(!commitStarted){
     if(pending)await request(`/api/v1/uploads/${pending.input.uploadId}`,'DELETE').catch(()=>{})
     pending=undefined
    }
    throw error
   }finally{
    if(!commitStarted&&!pending&&leaseEpoch!==undefined)await release(editorId,leaseEpoch)
    busy=false
   }
  },
 }
}
