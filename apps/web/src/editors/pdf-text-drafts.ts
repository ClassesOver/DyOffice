import type {TextInsertInput} from '../../../pdf/src/shared/ipc'
import type {createPdfPendingSession,PdfSessionTextDraft} from './pdf-pending-session'
import {pdfToView,viewToPdf,type PageGeom} from '../../../pdf/src/renderer/annotations'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {PdfTextInsert,PdfTextDraftInfo,PdfTextDraftTools} from './pdf-types'

type Entry=PdfSessionTextDraft
export function createPdfTextDrafts({fileId,request,getRevision,isReady,onChange,session,pageGeometry}:{fileId:string;request:SettingsRequest;getRevision:()=>string;isReady:()=>boolean;onChange:()=>void;session?:ReturnType<typeof createPdfPendingSession>;pageGeometry?:(page:number)=>PageGeom|undefined}){
 let localEntries:Entry[]=[],history:Entry[][]=[],baseRevision='',busy=false,generation=0
 const entries=():readonly Entry[]=>session?.readTextDrafts()??localEntries
 const copy=<T>(value:T):T=>structuredClone(value)
 function check(){
  if(busy)throw Error('文字布局正在计算，请稍候。')
  if(!isReady()||!getRevision())throw Error('当前不能编辑待保存文字，请先完成其他操作。')
  if(baseRevision&&baseRevision!==getRevision())throw Error('PDF 版本已变化，请放弃待保存文字后重新插入。')
 }
 function snapshot(){history.push(copy([...entries()]));if(history.length>100)history.shift()}
 function find(id:string){const entry=entries().find(entry=>entry.block.id===id);if(!entry)throw Error('待保存文字不存在，请重新列出文字块。');return entry}
 const currentRotation=(page:number)=>session?.read().rotations[page-1]??0
 function directions(entry:Entry){
  const {page}=entry.block,geom=pageGeometry?.(page),saved=entry.rotationDelta??0,current=currentRotation(page)
  return geom&&saved!==current?{from:{...geom,rot:geom.rot+saved},to:{...geom,rot:geom.rot+current}}:null
 }
 function displayed(entry:Entry){
  const g=directions(entry),b=entry.block
  if(!g)return b
  const a=pdfToView(g.to,...viewToPdf(g.from,b.x,b.y)),z=pdfToView(g.to,...viewToPdf(g.from,b.x+b.width,b.y+b.height))
  return {...b,x:Math.min(a[0],z[0]),y:Math.min(a[1],z[1]),width:Math.abs(z[0]-a[0]),height:Math.abs(z[1]-a[1])}
 }
 const recipe=(entry:Entry)=>({input:entry.input,id:entry.block.id,rotationDelta:entry.rotationDelta??0})
 async function replan(next:readonly ReturnType<typeof recipe>[],signal?:AbortSignal){
  signal?.throwIfAborted();check()
  if(next.length>20)throw Error('每次最多保存 20 个文字块，请先保存当前文字。')
  const revision=getRevision(),token=session?.read(),ticket=++generation;busy=true;onChange()
  try{
   // Save resolves one fallback font per face across all inserts, so preview the same batch.
   const rotationDeltas=next.map(entry=>entry.rotationDelta)
   const result=next.length?await request<{revision:string;blocks:Omit<PdfTextDraftInfo,'id'>[];inserts?:TextInsertInput[]}>(`/api/v1/files/${encodeURIComponent(fileId)}/pdf/text-inserts/query`,'POST',{revision,operations:next.map(entry=>entry.input),...(rotationDeltas.some(Boolean)?{rotationDeltas}:{})},signal):{revision,blocks:[],inserts:[]}
   signal?.throwIfAborted()
   if(ticket!==generation||revision!==getRevision()||!isReady())throw Error('PDF 版本或编辑状态已变化，请重新操作。')
   if(result.revision!==revision||!Array.isArray(result.blocks)||result.blocks.length!==next.length)throw Error('文字预览结果无效，请重新操作。')
   const planned=next.map(({input,id,rotationDelta},index)=>{
    const block=result.blocks[index]
    if(!block||block.page!==input.page||typeof block.text!=='string'||!block.text.trim()||block.text.length>20000||!['x','y','width','height','font_size'].every(key=>typeof block[key as keyof typeof block]==='number'&&Number.isFinite(block[key as keyof typeof block]))||block.width<=0||block.height<=0||block.font_size<=0||!/^#[a-fA-F0-9]{6}$/.test(block.color)||!['left','center','right'].includes(block.align)||(block.line_widths!==undefined&&(!Array.isArray(block.line_widths)||block.line_widths.length!==block.text.split('\n').length||block.line_widths.some(width=>!Number.isFinite(width)||width<0))))throw Error('文字预览结果无效，请重新操作。')
    const {anchor_text:_anchor,placement:_placement,...positioned}=input
    return {input:{...positioned,x:block.x,y:block.y},block:{...copy(block),id},rotationDelta}
   })
   if(session&&token){
    if(!result.inserts)throw Error('文字预览结果缺少原文坐标，请重新操作。')
    session.replaceTextDrafts(planned,result.inserts,token)
   }else{snapshot();localEntries=planned;baseRevision=revision}
  }finally{if(ticket===generation){busy=false;onChange()}}
 }
 async function plan(input:PdfTextInsert,id?:string,signal?:AbortSignal){
  if(session?.read().deleted.includes(input.page-1))throw Error('原始 PDF 页面已删除。')
  const pendingId=id??'T'+crypto.randomUUID(),next=entries().map(recipe)
  if(id){const index=next.findIndex(entry=>entry.id===id);next[index]={...next[index]!,input}}
  else next.push({input,id:pendingId,rotationDelta:currentRotation(input.page)})
  await replan(next,signal)
  return copy(displayed(find(pendingId)))
 }
 async function removeMany(ids:readonly string[],signal?:AbortSignal){
  signal?.throwIfAborted();check()
  if(!Array.isArray(ids)||ids.length<1||ids.length>50)throw Error('每批需要 1 至 50 项待保存文字删除操作。')
  if(ids.some(id=>typeof id!=='string'||!/^T[^\s\u0000-\u001f\u007f]+$/.test(id)))throw Error('请使用待保存文字的 T ID。')
  // Canonical PC removal is an idempotent filter, including unknown pending IDs.
  const selected=new Set(ids)
  if(!entries().some(entry=>selected.has(entry.block.id))){if(session){const result=session.apply(ids.map(id=>({op:'removeTextInsert',id})));if(result.failures.length)throw Error(result.failures[0]!.error)}else{snapshot();onChange()}return}
  await replan(entries().filter(entry=>!selected.has(entry.block.id)).map(recipe),signal)
 }
 function clear(){generation++;localEntries=[];history=[];baseRevision='';busy=false;if(session)session.discard();onChange()}
 const tools:PdfTextDraftTools={
  list:page=>copy(entries().filter(entry=>(page===undefined||entry.block.page===page)&&!session?.read().deleted.includes(entry.block.page-1)).map(displayed)),
  insert:(input,signal)=>plan(copy(input),undefined,signal),
  edit:async(input,signal)=>{check();const entry=find(input.id),{id,...patch}=input;return plan({...entry.input,...patch},id,signal)},
  move:async(input,signal)=>{
   check();const entry=find(input.id)
   if((input.x!==undefined&&input.dx!==undefined)||(input.y!==undefined&&input.dy!==undefined)||![input.x,input.y,input.dx,input.dy].some(value=>value!==undefined)||[input.x,input.y,input.dx,input.dy].some(value=>value!==undefined&&!Number.isFinite(value)))return Promise.reject(Error('文字移动坐标无效。'))
   const b=displayed(entry),x=input.x??b.x+(input.dx??0),y=input.y??b.y+(input.dy??0),g=directions(entry)
   if(!g)return plan({...entry.input,x,y},input.id,signal)
   const a=pdfToView(g.from,...viewToPdf(g.to,b.x,b.y)),z=pdfToView(g.from,...viewToPdf(g.to,x,y))
   return plan({...entry.input,x:entry.block.x+z[0]-a[0],y:entry.block.y+z[1]-a[1]},input.id,signal)
  },
  remove:async(id,signal)=>{check();find(id);await removeMany([id],signal)},
 }
 return {...tools,removeMany,
  hasPending:()=>entries().length>0,
  isBusy:()=>busy,
  canUndo:()=>session?session.canUndo():history.length>0,
  undo:()=>{check();if(session)return session.undo();if(!history.length)return false;localEntries=history.pop()!;onChange();return true},
  operations:()=>{if(baseRevision&&baseRevision!==getRevision())throw Error('PDF 版本已变化，请重新插入文字。');return copy(entries().map(entry=>entry.input))},
  saved:clear,discard:clear,
 }
}
