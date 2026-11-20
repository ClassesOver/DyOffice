import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {PdfHostImageBake,PdfPageGeometryOperation,SavePdfRequest,SavePdfResult} from '../../../pdf/src/shared/ipc'
import type {PdfPendingSnapshot} from './pdf-pending-ops'
import {createPdfMutations} from './pdf-mutations'
import type {RevisionRef} from '../../../../packages/web-contracts/src/api'
import {validatePdfStampOperation,type PdfStampOperation} from '../../../../packages/web-contracts/src/pdf-stamp-ops'
import type {StampConfig} from '../../../pdf/src/renderer/edit-state'

export function createNativePdfSave({fileId,path,request,getRevision,getPageCount,onSaved}:{
 fileId:string;path:string;request:SettingsRequest;getRevision:()=>string;getPageCount:()=>number
 onSaved:(receipt:RevisionRef)=>Promise<void>
}){
 const mutations=createPdfMutations({fileId,request,getRevision,onSaved})
 const refused:SavePdfResult={ok:false,error:'此批 PDF 修改无法在 Web 保存，草稿已保留。'}
 const unknown:SavePdfResult={ok:false,unconfirmed:true,error:'PDF 保存结果未确认，请再次点击保存以核对回执。'}
 async function confirm():Promise<SavePdfResult>{
  try{return await mutations.confirm()?{ok:true}:refused}
  catch{return mutations.hasPending()?unknown:refused}
 }
 async function rewrite(action:'page-ops'|'replace-pages'|'insert-pages',operation:PdfPageGeometryOperation|{pages:readonly number[];source:File}|{afterPageIndex:number;source:File},check?:()=>boolean,signal?:AbortSignal):Promise<SavePdfResult>{
  if(mutations.hasPending())return unknown
  try{return await mutations.mutate(action,[operation],signal,check)?{ok:true}:refused}
  catch{return mutations.hasPending()?confirm():refused}
 }
 return {
  confirm,
  pageGeometry:(operation:PdfPageGeometryOperation,check:()=>boolean,signal?:AbortSignal)=>rewrite('page-ops',operation,check,signal),
  replacePages:(pages:readonly number[],source:File,check:()=>boolean,signal?:AbortSignal)=>rewrite('replace-pages',{pages,source},check,signal),
  insertPdf:(afterPageIndex:number,source:File,check:()=>boolean,signal?:AbortSignal)=>rewrite('insert-pages',{afterPageIndex,source},check,signal),
  async save(draft:SavePdfRequest,check?:()=>boolean,stamps?:StampConfig|null,imageBakes:readonly PdfHostImageBake[]=[]):Promise<SavePdfResult>{
   if(mutations.hasPending())return unknown
   if(draft.path!==path||draft.targetPath!==undefined||draft.protectionDirty||draft.encryption||draft.decryption||
    draft.outline!==undefined||draft.attachments!==undefined||
    [draft.stamps,draft.redactions,draft.formWidgetEdits].some(items=>items?.length)||
    // Check and cross artwork is already in imageEdits. Web does not store the desktop form-fill metadata.
    draft.staticFormFills?.some(fill=>fill.kind!=='check'&&fill.kind!=='cross')||
    draft.drawings.some(item=>item.kind!=='note'))return refused
   const originalCount=getPageCount(),baseRevision=getRevision(),blankPages=draft.blankPages??[],count=originalCount+blankPages.length
   if(!baseRevision||!Number.isSafeInteger(originalCount)||originalCount<1||count>100)return refused
   const pages=Array.from({length:count},(_,page)=>page),valid=(page:number)=>Number.isInteger(page)&&page>=0&&page<count
   const deleted=draft.deletedPages??[],removed=new Set(deleted)
   if(deleted.some(page=>!valid(page))||removed.size!==deleted.length||removed.size===count)return refused
   const order=draft.pageOrder
   if(order&&(order.length!==count-removed.size||new Set(order).size!==order.length||order.some(page=>!valid(page)||removed.has(page))))return refused
   const rotations:Record<number,number>={},seen=new Set<number>()
   for(const {pageIndex,delta} of draft.rotations??[]){
    if(!valid(pageIndex)||!Number.isSafeInteger(delta)||delta%90!==0||seen.has(pageIndex))return refused
    seen.add(pageIndex)
    const normalized=(delta%360+360)%360
    if(normalized)rotations[pageIndex]=normalized
   }
   if(new Set(draft.formValues.map(value=>value.name)).size!==draft.formValues.length)return refused
   const stampOperations:PdfStampOperation[]=[]
   try{
    const wm=stamps?.wm,hf=stamps?.hf
    if(wm)stampOperations.push(validatePdfStampOperation({op:'set_watermark',text:wm.text,angle:wm.angle,color:wm.color,opacity:wm.opacity,size:wm.sizeRatio}))
    else if(stamps?.clearWatermark)stampOperations.push({op:'set_watermark',text:''})
    if(hf)stampOperations.push(validatePdfStampOperation({op:'set_header_footer',header_left:hf.headerLeft,header_center:hf.headerCenter,header_right:hf.headerRight,
     footer_left:hf.footerLeft,footer_center:hf.footerCenter,footer_right:hf.footerRight,page_number:hf.pageNumber,start_at:hf.startAt,font_size:hf.fontSize,color:hf.color}))
    else if(stamps?.clearHeaderFooter)stampOperations.push({op:'set_header_footer'})
   }catch{return refused}
   const snapshot:PdfPendingSnapshot&{stampOperations?:readonly PdfStampOperation[]}={
    fileId,baseRevision,generation:0,
    ...(blankPages.length?{blankPages}:{}),
    ...(draft.textEdits?.length?{textEdits:draft.textEdits}:{}),
    ...(draft.annotDeletes?.length?{annotDeletes:draft.annotDeletes}:{}),
    ...(draft.noteEdits?.length?{noteEdits:draft.noteEdits}:{}),
    ...(draft.annotationAuthor?{annotationAuthor:draft.annotationAuthor}:{}),
    ...(stampOperations.length?{stampOperations}:{}),
    ...(imageBakes.length?{savedImageEdits:imageBakes}:{}),
    markups:draft.markups.map((markup,index)=>({...markup,id:'Pm'+index})),
    notes:draft.drawings.flatMap((input,index)=>input.kind==='note'?[{id:'Pn'+index,input:{...input,...(draft.annotationAuthor&&!input.author?{author:draft.annotationAuthor}:{})}}]:[]),
    textInserts:(draft.textInserts??[]).map((input,index)=>({id:'T'+index,input})),
    imageEdits:(draft.imageEdits??[]).map((input,index)=>({id:'I'+index,input})),
    formEdits:Object.fromEntries(draft.formValues.map(input=>[input.name,input])),
    formFields:(draft.formFields??[]).map((input,index)=>({id:'F'+index,input})),
    rotations,deleted,order:order?[...order,...pages.filter(page=>removed.has(page))]:null,metadata:draft.metadata??null,
   }
   try{return await mutations.mutate('apply-ops',[snapshot],undefined,check)?{ok:true}:refused}
   catch{return mutations.hasPending()?confirm():refused}
  },
 }
}
