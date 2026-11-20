import type {ImageEditInput} from '../../../pdf/src/shared/ipc'
import type {createPdfPendingSession,PdfSessionImageDraft} from './pdf-pending-session'
import {pdfToView,viewToPdf,type PageGeom} from '../../../pdf/src/renderer/annotations'
import type {PdfPendingSnapshot} from './pdf-pending-ops'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {PdfImageBytes} from '../shell/pdf-preview-skill'
import {base64ByteSize,getPdfImageDraftCrop,inspectPdfImageDraftBytes,transformPdfImageDraftPixels,validatePdfImageDraftBake,type PdfImageDraftBakeOperation,type TransformPdfImageDraftPixels} from './pdf-image-draft-pixels'
export type {PdfImageDraftBakeOperation,TransformPdfImageDraftPixels} from './pdf-image-draft-pixels'
export type PendingImageInsert={page:number;image:PdfImageBytes;anchor_text?:string;placement?:'above'|'below'|'left'|'right';x?:number;y?:number;width?:number;height?:number;layer?:'above_text'|'below_text'}
export type PdfImageDraftInfo={id:string;page:number;x:number;y:number;width:number;height:number;layer:'above_text'|'below_text';pixelWidth:number;pixelHeight:number;image:PdfImageBytes}
type Entry=PdfSessionImageDraft
type Geometry=Pick<PendingImageInsert,'x'|'y'|'width'|'height'|'layer'>
const MAX_TOTAL=20*1024*1024,MAX_HISTORY=40*1024*1024
const clone=<T>(value:T):T=>structuredClone(value)
const bytesSize=(image:PdfImageBytes)=>base64ByteSize(image.base64)
const payloadSize=(entries:readonly Entry[])=>entries.reduce((total,entry)=>total+bytesSize(entry.info.image),0)
function memory(entries:readonly Entry[]){const images=new Map<string,number>();for(const entry of entries)for(const image of [entry.info.image,entry.opacityBase])images.set(image.base64,bytesSize(image));return [...images.values()].reduce((sum,n)=>sum+n,0)}
function validateGeometry(input:Geometry){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['x','y','width','height','layer'].includes(key))||['x','y','width','height'].some(key=>{const value=input[key as keyof Geometry];return value!==undefined&&(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>100000||['width','height'].includes(key)&&value<=0)})||input.layer!==undefined&&!['above_text','below_text'].includes(input.layer))throw Error('图片位置或尺寸无效。')
}
export function createPdfImageDrafts({fileId,request,getRevision,isReady,onChange,transformPixels=transformPdfImageDraftPixels,session,pageGeometry}:{fileId:string;request:SettingsRequest;getRevision:()=>string;isReady:()=>boolean;onChange:()=>void;transformPixels?:TransformPdfImageDraftPixels;session?:ReturnType<typeof createPdfPendingSession>;pageGeometry?:(page:number)=>PageGeom|undefined}){
 let localEntries:Entry[]=[],history:Entry[][]=[],baseRevision='',busy=false,generation=0
 const entries=():readonly Entry[]=>session?.readImageDrafts()??localEntries
 const rotation=(page:number)=>session?.read().rotations[page-1]??0
 function project(info:PdfImageDraftInfo,from:number,to:number){
  const geom=pageGeometry?.(info.page)
  if(!geom||from===to)return info
  const a={...geom,rot:geom.rot+from},b={...geom,rot:geom.rot+to}
  const [x,y]=pdfToView(b,...viewToPdf(a,info.x,info.y)),[right,bottom]=pdfToView(b,...viewToPdf(a,info.x+info.width,info.y+info.height))
  return {...info,x:Math.min(x,right),y:Math.min(y,bottom),width:Math.abs(x-right),height:Math.abs(y-bottom)}
 }
 const displayed=(entry:Entry)=>project(entry.info,entry.rotationDelta??0,rotation(entry.info.page))
 function unchanged(token:PdfPendingSnapshot|undefined){const now=session?.read();return !token||now?.fileId===token.fileId&&now.baseRevision===token.baseRevision&&now.generation===token.generation}
 function check(){if(busy)throw Error('图片正在处理，请稍候。');if(!isReady()||!getRevision())throw Error('当前不能编辑待保存图片，请先完成其他操作。');if(baseRevision&&baseRevision!==getRevision())throw Error('PDF 版本已变化，请放弃待保存图片后重新插入。')}
 function find(id:string){const entry=entries().find(entry=>entry.info.id===id);if(!entry)throw Error('待保存图片不存在，请重新选择。');return entry}
 function store(next:Entry[],replacement?:{id:string;edit:Extract<ImageEditInput,{kind:'insertImage'}>},token=session?.read()){
  if(session&&token){
   const edits=next.map((entry):Extract<ImageEditInput,{kind:'insertImage'}>=>{const input=replacement?.id===entry.info.id?replacement.edit:token.imageEdits.find(e=>e.id===entry.info.id)?.input;if(input?.kind!=='insertImage')throw Error('图片预览结果缺少原文坐标，请重新操作。');return {...input,rect:[...input.rect]}})
   session.replaceImageDrafts(next,edits,token);return
  }
  if(next.length>20||payloadSize(next)>MAX_TOTAL||memory(next)>MAX_TOTAL)throw Error('待保存图片最多 20 张，压缩图片合计不能超过 20 MiB。')
  history.push(localEntries);while(history.length>50||memory(history.flat())>MAX_HISTORY)history.shift()
  localEntries=next;baseRevision=getRevision()
 }
 async function plan(operation:PendingImageInsert,id:string,opacityBase:PdfImageBytes,signal?:AbortSignal,bake?:PdfImageDraftBakeOperation){
  signal?.throwIfAborted();check()
  const revision=getRevision(),token=session?.read(),ticket=++generation;busy=true;onChange()
  const rotationDelta=entries().find(entry=>entry.info.id===id)?.rotationDelta??(token?.rotations[operation.page-1]??0)
  try{
   if(token&&(token.fileId!==fileId||token.baseRevision!==revision||token.deleted.includes(operation.page-1)))throw Error('PDF 版本或页面状态已变化，请重新操作。')
   let input=clone(operation);opacityBase=clone(opacityBase);bake=bake?clone(bake):undefined
   if(bake){
    const source=bake.kind==='opacity'?opacityBase:input.image
    input.image=await transformPixels(source,bake,signal)
    inspectPdfImageDraftBytes(input.image)
    if(bake.kind!=='opacity')opacityBase=input.image
   }
   signal?.throwIfAborted()
   if(ticket!==generation||revision!==getRevision()||!isReady()||!unchanged(token))throw Error('PDF 版本或编辑状态已变化，请重新操作。')
   const decoded=inspectPdfImageDraftBytes(input.image)
   const result=await request<{revision:string;image:Omit<PdfImageDraftInfo,'id'|'image'>;edit?:Extract<ImageEditInput,{kind:'insertImage'}>}>(`/api/v1/files/${encodeURIComponent(fileId)}/pdf/image-inserts/query`,'POST',{revision,operation:input,...(rotationDelta?{rotationDelta}:{})},signal)
   signal?.throwIfAborted()
   if(ticket!==generation||revision!==getRevision()||!isReady()||!unchanged(token))throw Error('PDF 版本或编辑状态已变化，请重新操作。')
   const info=result.image
   if(result.revision!==revision||!info||info.page!==input.page||!['x','y','width','height'].every(key=>typeof info[key as keyof typeof info]==='number'&&Number.isFinite(info[key as keyof typeof info]))||info.x<0||info.y<0||info.width<=0||info.height<=0||!['above_text','below_text'].includes(info.layer)||info.pixelWidth!==decoded.width||info.pixelHeight!==decoded.height)throw Error('图片预览结果无效，请重新操作。')
   const entry={info:{...clone(info),id,image:input.image},opacityBase:clone(opacityBase),rotationDelta}
   const previous=entries().findIndex(entry=>entry.info.id===id),next=previous<0?[...entries(),entry]:entries().map((old,index)=>index===previous?entry:old)
   if(session&&!result.edit)throw Error('图片预览结果缺少原文坐标，请重新操作。')
   store(next,result.edit?{id,edit:result.edit}:undefined,token);return clone(displayed(entry))
  }finally{if(ticket===generation){busy=false;onChange()}}
 }
 const operation=(entry:Entry):PendingImageInsert=>{const {page,image,x,y,width,height,layer}=entry.info;return clone({page,image,x,y,width,height,layer})}
 function clear(){generation++;localEntries=[];history=[];baseRevision='';busy=false;if(session)session.discard();onChange()}
 return {
  list:()=>clone(entries().filter(entry=>!session?.read().deleted.includes(entry.info.page-1)).map(displayed)),
  async insert(input:PendingImageInsert&{op:'insert_image'},signal?:AbortSignal){
   signal?.throwIfAborted();check()
   if(!input||input.op!=='insert_image'||Object.keys(input).some(key=>!['op','page','image','anchor_text','placement','x','y','width','height','layer'].includes(key))||!Number.isSafeInteger(input.page)||input.page<1||input.page>100||input.anchor_text!==undefined&&(typeof input.anchor_text!=='string'||!input.anchor_text.trim()||input.anchor_text.length>2000)||input.placement!==undefined&&!['above','below','left','right'].includes(input.placement))throw Error('新增图片参数无效。')
   if(entries().length>=20)throw Error('待保存图片最多 20 张。')
   const {op:_op,page,image,anchor_text,placement,...geometry}=input;validateGeometry(geometry);inspectPdfImageDraftBytes(image)
   const pending={page,image,...(anchor_text!==undefined?{anchor_text}:{}),...(placement!==undefined?{placement}:{}),...geometry}
   if(!session&&payloadSize(entries())+bytesSize(image)>MAX_TOTAL)throw Error('待保存图片压缩大小不能超过 20 MiB。')
   return plan(pending,'I'+crypto.randomUUID(),image,signal)
  },
  async transform(id:string,geometry:Geometry,signal?:AbortSignal){
   signal?.throwIfAborted();check();validateGeometry(geometry)
   if(!Object.values(geometry).some(value=>value!==undefined))throw Error('请指定图片位置或尺寸。')
   const entry=find(id),box=displayed(entry)
   const width=geometry.width??(geometry.height===undefined?box.width:box.width*geometry.height/box.height)
   const height=geometry.height??(geometry.width===undefined?box.height:box.height*geometry.width/box.width)
   const projected=project({...box,x:geometry.x??box.x,y:geometry.y??box.y,width,height},rotation(box.page),entry.rotationDelta??0)
   return plan({...operation(entry),x:projected.x,y:projected.y,width:projected.width,height:projected.height,layer:geometry.layer??box.layer},id,entry.opacityBase,signal)
  },
  async replace(id:string,image:PdfImageBytes,signal?:AbortSignal){
   signal?.throwIfAborted();check();const entry=find(id)
   inspectPdfImageDraftBytes(image)
   if(!session&&payloadSize(entries())-bytesSize(entry.info.image)+bytesSize(image)>MAX_TOTAL)throw Error('待保存图片压缩大小不能超过 20 MiB。')
   return plan({...operation(entry),image},id,image,signal)
  },
  async bake(id:string,bake:PdfImageDraftBakeOperation,signal?:AbortSignal){
   signal?.throwIfAborted();check();validatePdfImageDraftBake(bake)
   const entry=find(id),input=operation(entry),{info}=entry
   const turns=((rotation(info.page)-(entry.rotationDelta??0)+360)%360)/90
   if(bake.kind==='flip'&&turns%2)bake={...bake,axis:bake.axis==='horizontal'?'vertical':'horizontal'}
   if(bake.kind==='crop'&&turns){
    const sides=['top','right','bottom','left'] as const,crop=bake
    bake={kind:'crop',...Object.fromEntries(sides.map((side,i)=>[side,crop[sides[(i+turns)%4]!]]))}
   }
   if(bake.kind==='rotate'&&bake.direction!=='180'){
    input.x=info.x+(info.width-info.height)/2;input.y=info.y+(info.height-info.width)/2;input.width=info.height;input.height=info.width
   }else if(bake.kind==='crop'){
    const crop=getPdfImageDraftCrop(info.pixelWidth,info.pixelHeight,bake)
    input.x=info.x+info.width*crop.x/info.pixelWidth;input.y=info.y+info.height*crop.y/info.pixelHeight;input.width=info.width*crop.width/info.pixelWidth;input.height=info.height*crop.height/info.pixelHeight
   }
   return plan(input,id,entry.opacityBase,signal,bake)
  },
  remove(id:string){check();find(id);store(entries().filter(entry=>entry.info.id!==id));onChange()},
  undo(){check();if(session)return session.undo();if(!history.length)return false;localEntries=history.pop()!;onChange();return true},
  canUndo:()=>session?session.canUndo():history.length>0,hasPending:()=>entries().length>0,isBusy:()=>busy,
  operations:()=>{if(baseRevision&&baseRevision!==getRevision())throw Error('PDF 版本已变化，请重新插入图片。');return entries().map(operation)},
  saved:clear,discard:clear,
 }
}
