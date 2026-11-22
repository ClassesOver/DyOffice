import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {PendingImageInsert} from './pdf-image-drafts'
import type {PdfTextInsert} from './pdf-types'
import type {PdfImageOperation,PdfImageContentOperation} from './pdf-types'
import {base64ByteSize,inspectPdfImageDraftBytes} from './pdf-image-draft-pixels'
import type {createPdfPendingSession} from './pdf-pending-session'
import {queryPdfPendingPreview} from './pdf-pending-preview'
export type PdfSavedImageOperation=PdfImageOperation|Extract<PdfImageContentOperation,{op:'replace_image'}>
const clone=<T>(value:T):T=>structuredClone(value)
const bytes=(operations:readonly PdfSavedImageOperation[])=>operations.reduce((sum,operation)=>sum+(operation.op==='replace_image'?base64ByteSize(operation.image.base64):0),0)
export function createPdfSavedImageDrafts({fileId,request,getRevision,isReady,onChange,session,getOtherDrafts=()=>({texts:[],images:[]})}:{fileId:string;request:SettingsRequest;getRevision:()=>string;isReady:()=>boolean;onChange:()=>void;session?:ReturnType<typeof createPdfPendingSession>;getOtherDrafts?:()=>{texts:readonly PdfTextInsert[];images:readonly PendingImageInsert[]}}){
 let operations:PdfSavedImageOperation[]=[],history:PdfSavedImageOperation[][]=[],revision='',busy=false,generation=0
 function check(){
  if(busy)throw Error('图片正在处理，请稍候。')
  if(!isReady()||!getRevision())throw Error('当前不能编辑已有图片，请先完成其他操作。')
  if(revision&&revision!==getRevision())throw Error('PDF 版本已变化，请放弃已有图片编辑后重新操作。')
 }
 function clear(){generation++;operations=[];history=[];revision='';busy=false;onChange()}
 return {
  async queue(operation:PdfSavedImageOperation,signal?:AbortSignal){
   signal?.throwIfAborted();check()
   if(!operation||!['transform_image','rotate_image','delete_image','flip_image','set_image_opacity','crop_image','remove_image_background','replace_image'].includes(operation.op)||!Number.isSafeInteger(operation.page)||operation.page<1||operation.page>100||!Number.isSafeInteger(operation.image_number)||operation.image_number<1||operation.image_number>1000)throw Error('已有图片编辑参数无效。')
   const token=session?.read(),existing=token?.savedImageEdits??operations
   if(token?.deleted.includes(operation.page-1))throw Error('原始 PDF 页面已删除。')
   if(existing.some(item=>item.page===operation.page&&item.image_number===operation.image_number))throw Error('该图片已有待保存编辑，请先保存或撤销，再继续编辑。')
   if(existing.length>=20)throw Error('已有图片编辑最多 20 项。')
   if(operation.op==='replace_image')inspectPdfImageDraftBytes(operation.image)
   const next=clone([...existing,operation])
   if(bytes(next)>20*1024*1024)throw Error('替换图片合计不能超过 20 MiB。')
   const current=getRevision(),ticket=++generation;busy=true;onChange()
   try{
    const result=token?await queryPdfPendingPreview(request,{...token,savedImageEdits:next},signal):await request<{revision:string}>(`/api/v1/files/${encodeURIComponent(fileId)}/pdf/draft-inserts/query`,'POST',{revision:current,operation:{...getOtherDrafts(),imageEdits:next}},signal)
    signal?.throwIfAborted()
    if(ticket!==generation||current!==getRevision()||!isReady()||result.revision!==current)throw Error('PDF 版本或编辑状态已变化，请重新操作。')
    if(token&&session){session.replaceSavedImageEdits(next,token);return}
    history.push(operations);while(history.length>40||bytes(history.flat())>40*1024*1024)history.shift()
    operations=next;revision=current
   }finally{if(ticket===generation){busy=false;onChange()}}
  },
  list:()=>clone(session?.read().savedImageEdits??operations),
  operations:()=>{if(revision&&revision!==getRevision())throw Error('PDF 版本已变化，请放弃已有图片编辑。');return clone(operations)},
  isClaimed:(page:number,imageNumber:number)=>(session?.read().savedImageEdits??operations).some(operation=>operation.page===page&&operation.image_number===imageNumber),
  hasPending:()=>(session?.read().savedImageEdits??operations).length>0,isBusy:()=>busy,canUndo:()=>history.length>0,
  undo(){check();if(!history.length)return false;operations=history.pop()!;onChange();return true},
  saved:clear,discard:clear,
 }
}
