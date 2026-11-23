import type {PdfSavedImageOperation} from './pdf-saved-image-drafts'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {PdfImageInfo,PdfImageOperation,PdfImageTools,PdfImageContentOperation,PdfImageBytes,PdfImageDraftInfo} from './pdf-types'

export function createPdfImageAccess({fileId,request,getRevision,isReady,write,fetchImage,writeContent,queueInsert,queueEdit,isClaimed,isDraftReady,isReadable}:{fileId:string;request:SettingsRequest;getRevision:()=>string;isReady:()=>boolean;write:(operation:PdfImageOperation,signal?:AbortSignal)=>Promise<boolean>;fetchImage?:(url:string,signal?:AbortSignal)=>Promise<{base64:string;mime:string}|null>;writeContent?:(operation:PdfImageContentOperation,signal?:AbortSignal)=>Promise<boolean>;queueInsert?:(operation:Extract<PdfImageContentOperation,{op:'insert_image'}>,signal?:AbortSignal)=>Promise<PdfImageDraftInfo>;queueEdit?:(operation:PdfSavedImageOperation,signal?:AbortSignal)=>Promise<void>;isClaimed?:(page:number,imageNumber:number)=>boolean;isDraftReady?:()=>boolean;isReadable?:()=>boolean}):PdfImageTools{
 let snapshot:{revision:string;images:readonly PdfImageInfo[]}|undefined
 let sequence=0
 async function resolveImage(url:string,signal?:AbortSignal):Promise<PdfImageBytes>{
   let image:{base64:string;mime:string}|null
   if(url.startsWith('data:')){
    const match=/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url)
    if(!match)throw Error('PDF 图片仅支持 PNG 或 JPEG；请重新生成或选择这两种格式。')
    image={mime:match[1]!,base64:match[2]!}
   }else{
    let parsed:URL
    try{parsed=new URL(url)}catch{throw Error('图片地址无效。')}
    if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('图片地址必须使用 HTTPS。')
    image=await fetchImage?.(url,signal)??null
   }
   signal?.throwIfAborted()
   if(!image||!['image/png','image/jpeg'].includes(image.mime))throw Error('图片下载失败，或不是 PNG/JPEG。')
   if(image.base64.length>Math.ceil(5*1024*1024/3)*4||!image.base64.length||image.base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64))throw Error('图片数据无效或超过 5 MiB。')
   const decoded=atob(image.base64)
   if(decoded.length>5*1024*1024||btoa(decoded)!==image.base64)throw Error('图片数据无效或超过 5 MiB。')
   return image as PdfImageBytes
 }
 return {
  ...(queueEdit?{editsAreDrafts:true}:{}),
  ...(queueInsert?{async insertDraft(input:Extract<import('./pdf-types').PdfImageContentInput,{op:'insert_image'}>,signal?:AbortSignal){
   signal?.throwIfAborted()
   const revision=getRevision(),ready=isDraftReady??isReady
   if(!revision||!ready())throw Error('PDF 尚未就绪，或有修改等待保存确认。')
   const {url,...operation}=input,image=await resolveImage(url,signal)
   signal?.throwIfAborted()
   if(revision!==getRevision()||!ready())throw Error('PDF 版本或编辑状态已变化，请重新插入图片。')
   return queueInsert({...operation,image},signal)
  }}:{}),
  ...(fetchImage&&(writeContent||queueEdit)?{async content(input:import('./pdf-types').PdfImageContentInput,signal?:AbortSignal){
   signal?.throwIfAborted()
   const revision=getRevision()
   if(!revision||!isReady()||input.op==='replace_image'&&(snapshot?.revision!==revision||!snapshot.images.some(image=>image.page===input.page&&image.image_number===input.image_number))||input.op==='replace_image'&&isClaimed?.(input.page,input.image_number))return false
   snapshot=undefined;sequence++
   const {url,...operation}=input
   const image=await resolveImage(url,signal)
   if(revision!==getRevision()||!isReady())return false
   snapshot=undefined;sequence++
   if(operation.op==='replace_image'&&queueEdit){await queueEdit({...operation,image},signal);return true}
   return writeContent?.({...operation,image},signal)??false
  }}:{}),
  async read(page,signal){
   signal?.throwIfAborted()
   const current=++sequence,revision=getRevision();snapshot=undefined
   if(!revision||!(isReadable??isReady)())throw Error('PDF 尚未就绪，或有修改等待保存确认。')
   const result=await request<{revision:string;images:PdfImageInfo[]}>(`/api/v1/files/${fileId}/pdf/images/query`,'POST',{revision},signal)
   signal?.throwIfAborted()
   if(current!==sequence||revision!==getRevision()||!(isReadable??isReady)()||result.revision!==revision)throw Error('PDF 版本已变化，请重新读取图片列表。')
   if(!Array.isArray(result.images)||result.images.length>1000||result.images.some(image=>!image||!Number.isSafeInteger(image.page)||image.page<1||image.page>100||!Number.isSafeInteger(image.image_number)||image.image_number<1||image.image_number>1000||![image.x,image.y,image.width,image.height].every(Number.isFinite)||image.width<=0||image.height<=0||!['above_text','below_text'].includes(image.layer)))throw Error('PDF 图片列表无效。')
   const images=result.images.filter(image=>page===undefined||image.page===page).map(image=>({...image,...(isClaimed?.(image.page,image.image_number)?{pending:true}:{})}))
   if(new Set(images.map(image=>`${image.page}:${image.image_number}`)).size!==images.length)throw Error('PDF 图片编号重复。')
   snapshot={revision,images};return images
  },
  async edit(operation,signal){
   signal?.throwIfAborted()
   if(!isReady()||snapshot?.revision!==getRevision()||!snapshot?.images.some(image=>image.page===operation.page&&image.image_number===operation.image_number)||isClaimed?.(operation.page,operation.image_number))return false
   snapshot=undefined;sequence++
   if(queueEdit){await queueEdit(operation,signal);return true}
   return write(operation,signal)
  },
 }
}
