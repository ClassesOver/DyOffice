import type {DrawingInput,MarkupInput,TextInsertInput,ImageEditInput} from '../../../pdf/src/shared/ipc'
import type {PdfImageDraftInfo} from './pdf-image-drafts'
import {inspectPdfImageDraftBytes} from './pdf-image-draft-pixels'
import type {PdfImageBytes,PdfTextInsert,PdfTextDraftInfo} from '../shell/pdf-preview-skill'
import {createEmptyPdfPendingSnapshot,planPdfPendingOps,type PdfPendingContext,type PdfPendingSnapshot} from './pdf-pending-ops'

export type PdfPendingToken=Pick<PdfPendingSnapshot,'fileId'|'baseRevision'|'generation'>
export interface PdfPreparedAnnotations {
 readonly markups:readonly (MarkupInput&{id:string})[]
 readonly notes:readonly {id:string;input:Extract<DrawingInput,{kind:'note'}>}[]
}
export type PdfSessionTextDraft={input:PdfTextInsert;block:PdfTextDraftInfo;rotationDelta?:number}
export type PdfSessionImageDraft={info:PdfImageDraftInfo;opacityBase:PdfImageBytes;rotationDelta?:number}
type HistoryEntry={snapshot:PdfPendingSnapshot;texts:readonly PdfSessionTextDraft[];images:readonly PdfSessionImageDraft[]}
const MAX_IMAGE_BYTES=20*1024*1024,MAX_IMAGE_HISTORY=40*1024*1024
function imageMemory(entries:readonly HistoryEntry[]){
 const images=new Set<string>()
 for(const entry of entries){for(const edit of entry.snapshot.imageEdits)if('image'in edit.input)images.add(edit.input.image);for(const edit of entry.snapshot.savedImageEdits??[])if(edit.op==='replace_image')images.add(edit.image.base64);for(const draft of entry.images){images.add(draft.info.image.base64);images.add(draft.opacityBase.base64)}}
 let bytes=0;for(const base64 of images)bytes+=base64.length/4*3-(base64.endsWith('==')?2:base64.endsWith('=')?1:0);return bytes
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}

/** One history owner for canonical PDF batches; all changes stay local until Save. */
export function createPdfPendingSession({getContext,onChange}:{getContext:()=>Omit<PdfPendingContext,'generation'|'dryRun'>;onChange:()=>void}){
 let current=createEmptyPdfPendingSnapshot({...getContext(),generation:0}),texts:readonly PdfSessionTextDraft[]=Object.freeze([]),images:readonly PdfSessionImageDraft[]=Object.freeze([]),past:HistoryEntry[]=[],future:HistoryEntry[]=[],closed=false
 function context(){
  if(closed)throw Error('PDF 编辑会话已关闭。')
  const value=getContext()
  if(value.fileId!==current.fileId||value.baseRevision!==current.baseRevision)throw Error('PDF 版本已变化，请放弃待保存修改后重新编辑。')
  if(value.readOnly)throw Error('当前 PDF 为只读。')
  return {...value,generation:current.generation}
 }
 const entry=():HistoryEntry=>({snapshot:current,texts,images})
 function trimHistory(){while(past.length+future.length&&imageMemory([...past,...future])>MAX_IMAGE_HISTORY){if(past.length)past.shift();else future.shift()}}
 function push(){past.push(entry());if(past.length>100)past.shift();future=[];trimHistory()}
 function checkToken(token:PdfPendingToken){
  if(token.fileId!==current.fileId||token.baseRevision!==current.baseRevision||token.generation!==current.generation)throw Error('PDF 版本或编辑状态已变化，请重新操作。')
 }
 function replay(saved:HistoryEntry){
  // History keeps immutable state, but generation never goes backwards (async ABA guard).
  texts=saved.texts;images=saved.images;current=Object.freeze({...saved.snapshot,generation:current.generation+1});trimHistory();onChange()
 }
 return {
  read:()=>current,
  readTextDrafts:()=>texts,
  readImageDrafts:()=>images,
  replaceSavedImageEdits(edits:NonNullable<PdfPendingSnapshot['savedImageEdits']>,token:PdfPendingToken){
   context();checkToken(token)
   push();current=freeze({...current,generation:current.generation+1,savedImageEdits:structuredClone(edits)});onChange()
  },
  replaceImageDrafts(drafts:readonly PdfSessionImageDraft[],edits:readonly Extract<ImageEditInput,{kind:'insertImage'}>[],token:PdfPendingToken){
   const ctx=context();checkToken(token)
   const invalid=()=>{throw Error('图片预览结果无效，请重新操作。')}
   if(!Array.isArray(drafts)||!Array.isArray(edits)||drafts.length!==edits.length||drafts.length>20)invalid()
   const nextImages=structuredClone(drafts),native=structuredClone(edits),saved=current.imageEdits.filter(e=>e.input.kind!=='insertImage'),ids=new Set(saved.map(e=>e.id)),decoded=new Map<string,{width:number;height:number}>()
   function inspect(image:PdfImageBytes){const key=image?.mime+':'+image?.base64;let d=decoded.get(key);if(!d){d=inspectPdfImageDraftBytes(image);decoded.set(key,{width:d.width,height:d.height})}return d}
   for(let i=0;i<nextImages.length;i++){
    const d=nextImages[i]!,t=native[i]!,info=d?.info,g=t?ctx.pageGeometries[t.pageIndex]:undefined
    if(!info||!t||typeof info.id!=='string'||!/^I[^\s\u0000-\u001f\u007f]{1,200}$/.test(info.id)||ids.has(info.id)||t.kind!=='insertImage'||Object.keys(t).some(k=>!['kind','pageIndex','image','rect','layer','rotate'].includes(k))||!Number.isSafeInteger(t.pageIndex)||!g||t.pageIndex!==info.page-1||!['x','y','width','height'].every(k=>Number.isFinite(info[k as 'x'|'y'|'width'|'height']))||info.x<0||info.y<0||info.width<=0||info.height<=0||!['above_text','below_text'].includes(info.layer)||t.layer!==(info.layer==='above_text'?'aboveText':'belowText')||t.image!==info.image?.base64||!Array.isArray(t.rect)||t.rect.length!==4||!t.rect.every(Number.isFinite)||t.rect[2]<=t.rect[0]||t.rect[3]<=t.rect[1]||t.rect[0]<(g.x0??0)-.01||t.rect[1]<(g.y0??0)-.01||t.rect[2]>(g.x0??0)+g.pw/(g.userUnit??1)+.01||t.rect[3]>(g.y0??0)+g.ph/(g.userUnit??1)+.01||t.rotate!==undefined&&![0,90,180,270].includes(t.rotate))invalid()
    const pixels=inspect(info.image);inspect(d.opacityBase)
    if(pixels.width!==info.pixelWidth||pixels.height!==info.pixelHeight)invalid()
    if(current.deleted.includes(t.pageIndex)&&!current.imageEdits.some(old=>old.id===info.id&&JSON.stringify(old.input)===JSON.stringify(t)))invalid()
    ids.add(info.id)
   }
   const next=freeze({...current,generation:current.generation+1,imageEdits:[...saved,...native.map((input,i)=>({id:nextImages[i]!.info.id,input}))]})
   if(next.imageEdits.length+next.markups.length+next.notes.length+next.textInserts.length+next.formFields.length+Object.keys(next.formEdits).length>250)invalid()
   const payloadBytes=next.imageEdits.reduce((sum,e)=>{if(!('image'in e.input))return sum;const base64=e.input.image;return sum+base64.length/4*3-(base64.endsWith('==')?2:base64.endsWith('=')?1:0)},0)
   if(payloadBytes>MAX_IMAGE_BYTES||imageMemory([{snapshot:next,texts,images:nextImages}])>MAX_IMAGE_BYTES)throw Error('待保存图片压缩大小合计不能超过 20 MiB。')
   push();images=freeze(nextImages);current=next;onChange()
  },
  replaceTextDrafts(drafts:readonly PdfSessionTextDraft[],inserts:readonly TextInsertInput[],token:PdfPendingToken){
   const ctx=context();checkToken(token)
   const invalid=()=>{throw Error('文字预览结果无效，请重新操作。')}
   if(!Array.isArray(drafts)||!Array.isArray(inserts)||drafts.length!==inserts.length||drafts.length>20)invalid()
   const nextTexts=structuredClone(drafts),native=structuredClone(inserts),ids=new Set<string>()
   for(let i=0;i<nextTexts.length;i++){
    const d=nextTexts[i]!,t=native[i]!
    if(!d?.block||!d.input||typeof d.block.id!=='string'||!/^T[^\s\u0000-\u001f\u007f]{1,200}$/.test(d.block.id)||ids.has(d.block.id)||!t||!Number.isSafeInteger(t.pageIndex)||!ctx.pageGeometries[t.pageIndex]||t.pageIndex!==d.input.page-1||t.text!==d.block.text||!Array.isArray(t.origin)||t.origin.length!==2||!t.origin.every(Number.isFinite)||!Number.isFinite(t.fontSize)||t.fontSize<=0||!Array.isArray(t.color)||t.color.length!==3||t.color.some(v=>!Number.isFinite(v)||v<0||v>255))invalid()
    if(current.deleted.includes(t.pageIndex)&&!current.textInserts.some(old=>old.id===d.block.id&&old.input.pageIndex===t.pageIndex))invalid()
    ids.add(d.block.id)
   }
   push();texts=freeze(nextTexts);current=freeze({...current,generation:current.generation+1,textInserts:native.map((input,i)=>({id:nextTexts[i]!.block.id,input}))});onChange()
  },
  apply(input:unknown,{dryRun=false,signal}:{dryRun?:boolean;signal?:AbortSignal}={}){
   signal?.throwIfAborted()
   const result=planPdfPendingOps(current,input,{...context(),dryRun})
   if(!result.failures.length&&!dryRun){
    push();current=result.next;texts=Object.freeze(texts.filter(t=>current.textInserts.some(item=>item.id===t.block.id)));onChange()
   }
   return result
  },
  /** Internal query result append; public tools still use the canonical operation planner. */
  appendAnnotations(prepared:PdfPreparedAnnotations,token:PdfPendingToken){
   const ctx=context()
   checkToken(token)
   const invalid=()=>{throw Error('批注预览结果无效，请重新操作。')}
   const value=structuredClone(prepared),ids=new Set([...current.markups.map(m=>m.id),...current.notes.map(n=>n.id)])
   const keys=(v:object,allowed:readonly string[],required=allowed)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k)))invalid()}
   keys(value,['markups','notes'])
   if(!Array.isArray(value.markups)||!Array.isArray(value.notes)||!value.markups.length&&!value.notes.length||current.markups.length+value.markups.length>100||current.notes.length+value.notes.length>100||current.markups.length+current.notes.length+value.markups.length+value.notes.length+current.textInserts.length+current.imageEdits.length+current.formFields.length+Object.keys(current.formEdits).length>250)invalid()
   function id(v:string){if(typeof v!=='string'||!/^P[^\s\u0000-\u001f\u007f]{1,200}$/.test(v)||ids.has(v))invalid();ids.add(v)}
   function points(page:number,coords:readonly number[]){
    const g=ctx.pageGeometries[page]
    if(!Number.isSafeInteger(page)||!g||current.deleted.includes(page))invalid()
    const geometry=g!
    for(let i=0;i<coords.length;i+=2)if(!Number.isFinite(coords[i])||!Number.isFinite(coords[i+1])||coords[i]!<(geometry.x0??0)-.01||coords[i]!>(geometry.x0??0)+geometry.pw/(geometry.userUnit??1)+.01||coords[i+1]!<(geometry.y0??0)-.01||coords[i+1]!>(geometry.y0??0)+geometry.ph/(geometry.userUnit??1)+.01)invalid()
   }
   const color=(v:readonly number[])=>{if(!Array.isArray(v)||v.length!==3||v.some(x=>!Number.isFinite(x)||x<0||x>1))invalid()}
   const text=(v:string,max:number)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
   for(const m of value.markups){
    keys(m,['id','pageIndex','type','color','quads']);id(m.id);color(m.color)
    if(!['highlight','underline','strikeout','squiggly'].includes(m.type)||!Array.isArray(m.quads)||!m.quads.length||m.quads.length>1000)invalid()
    for(const q of m.quads){if(!Array.isArray(q)||q.length!==8)invalid();points(m.pageIndex,q);const xs=[q[0]!,q[2]!,q[4]!,q[6]!],ys=[q[1]!,q[3]!,q[5]!,q[7]!];if(Math.max(...xs)<=Math.min(...xs)||Math.max(...ys)<=Math.min(...ys))invalid()}
   }
   for(const entry of value.notes){
    keys(entry,['id','input']);id(entry.id);const note=entry.input
    keys(note,['kind','pageIndex','color','at','contents','author','createdMs'],['kind','pageIndex','color','at','contents'])
    if(note.kind!=='note'||!text(note.contents,10000)||!note.contents.trim()||note.author!==undefined&&!text(note.author,200)||note.createdMs!==undefined&&(!Number.isSafeInteger(note.createdMs)||note.createdMs<0||note.createdMs>8640000000000000)||!Array.isArray(note.at)||note.at.length!==2)invalid()
    color(note.color);points(note.pageIndex,note.at)
   }
   const next=freeze({...current,generation:current.generation+1,markups:[...current.markups,...value.markups],notes:[...current.notes,...value.notes]})
   push();current=next;onChange();return current
  },
  canUndo:()=>past.length>0,
  canRedo:()=>future.length>0,
  undo(){
   context();if(!past.length)return false
   future.push(entry());replay(past.pop()!);return true
  },
  redo(){
   context();if(!future.length)return false
   past.push(entry());replay(future.pop()!);return true
  },
  discard(){
   if(closed)throw Error('PDF 编辑会话已关闭。')
   current=createEmptyPdfPendingSnapshot({...getContext(),generation:current.generation+1})
   texts=Object.freeze([]);images=Object.freeze([]);past=[];future=[];onChange()
  },
  dispose(){closed=true;past=[];future=[]},
 }
}
