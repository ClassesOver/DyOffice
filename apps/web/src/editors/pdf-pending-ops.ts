import {validatePdfApplyOperations} from '../../../../packages/web-contracts/src/pdf-apply-ops'
import {geomDispSize,viewToPdf,type PageGeom} from '../../../pdf/src/renderer/annotations'
import type {AnnotDeleteInput,BlankPageInput,DrawingInput,FormFieldInput,FormValueInput,ImageEditInput,MarkupInput,NoteEditInput,TextEditInput,TextInsertInput} from '../../../pdf/src/shared/ipc'
import type {PdfSavedImageOperation} from './pdf-saved-image-drafts'

type Frozen<T>=T extends readonly unknown[]?{readonly [K in keyof T]:Frozen<T[K]>}:T extends object?{readonly [K in keyof T]:Frozen<T[K]>}:T
export type PdfPendingMetadata=Readonly<Partial<Record<'title'|'author'|'subject'|'keywords',string>>>
export interface PdfPendingState {
 readonly annotationAuthor?:string
 readonly annotDeletes?:readonly Frozen<AnnotDeleteInput>[]
 readonly noteEdits?:readonly Frozen<NoteEditInput>[]
 readonly blankPages?:readonly Frozen<BlankPageInput>[]
 readonly textEdits?:readonly Frozen<TextEditInput>[]
 readonly markups:readonly Frozen<MarkupInput&{id:string}>[]
 readonly notes:readonly Frozen<{id:string;input:Extract<DrawingInput,{kind:'note'}>}>[]
 readonly textInserts:readonly Frozen<{id:string;input:TextInsertInput}>[]
 readonly imageEdits:readonly Frozen<{id:string;input:ImageEditInput}>[]
 readonly savedImageEdits?:readonly Frozen<PdfSavedImageOperation>[]
 readonly formEdits:Readonly<Record<string,Frozen<FormValueInput>>>
 readonly formFields:readonly Frozen<{id:string;input:FormFieldInput}>[]
 /** Every key/index is an original, zero-based page identity, including deleted pages in order. */
 readonly rotations:Readonly<Record<number,number>>
 readonly deleted:readonly number[]
 readonly order:readonly number[]|null
 /** null restores saved properties; an object contains only pending overrides. */
 readonly metadata:PdfPendingMetadata|null
}
export interface PdfPendingSnapshot extends PdfPendingState {readonly fileId:string;readonly baseRevision:string;readonly generation:number}
export interface PdfPendingSavedField {
 readonly name:string
 readonly kind:'text'|'checkbox'|'radio'|'choice'|'signature'|'button'
 readonly pageIndex:number
 readonly readOnly?:boolean
 readonly options?:readonly string[]
 readonly maxLen?:number
}
export interface PdfPendingContext {
 readonly fileId:string
 readonly baseRevision:string
 readonly generation:number
 /** Authorized saved page geometry; the planner adds the snapshot's rotation at batch start. */
 readonly pageGeometries:readonly Readonly<PageGeom>[]
 readonly savedFields:readonly PdfPendingSavedField[]
 readonly readOnly?:boolean
 readonly dryRun?:boolean
}
export type PdfPendingBucket=keyof PdfPendingState
export interface PdfPendingPlan {
 readonly next:PdfPendingSnapshot
 readonly touched:readonly PdfPendingBucket[]
 readonly focusPage:number|null
 readonly failures:readonly {readonly index:number;readonly error:string}[]
}
function fail(message:string):never{throw Error(message)}
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}
 return value
}
function checkContext(context:PdfPendingContext){
 if(!context.fileId||!context.baseRevision||!Number.isSafeInteger(context.generation)||context.generation<0||context.generation>=Number.MAX_SAFE_INTEGER||!Array.isArray(context.pageGeometries)||context.pageGeometries.length<1||context.pageGeometries.length>100)fail('Invalid PDF pending context.')
 for(const g of context.pageGeometries)if(!g||![g.pw,g.ph,g.rot,g.x0??0,g.y0??0,g.userUnit??1].every(Number.isFinite)||g.pw<=0||g.ph<=0||!Number.isInteger(g.rot/90)||(g.userUnit??1)<=0)fail('Invalid PDF page geometry.')
}
export function createEmptyPdfPendingSnapshot(context:PdfPendingContext):PdfPendingSnapshot{
 checkContext(context)
 return freeze({fileId:context.fileId,baseRevision:context.baseRevision,generation:context.generation,markups:[],notes:[],textInserts:[],imageEdits:[],formEdits:{},formFields:[],rotations:{},deleted:[],order:null,metadata:null})
}
/** Pure transaction only. The owner stores this single next object as one undo step.
 * P/T missing IDs follow PC's idempotent reducers; saved annotations never enter these buckets.
 * Native payloads keep original zero-based pages. Field geometry uses batch-start rotation.
 */
export function planPdfPendingOps(snapshot:PdfPendingSnapshot,raw:unknown,context:PdfPendingContext):PdfPendingPlan{
 let index=-1,focusPage:number|null=null
 const rejected=(error:unknown):PdfPendingPlan=>({next:snapshot,touched:[],focusPage:null,failures:[{index,error:error instanceof Error?error.message:String(error)}]})
 try{
  checkContext(context)
  if(context.readOnly)fail('The PDF is read-only.')
  if(snapshot.fileId!==context.fileId||snapshot.baseRevision!==context.baseRevision||snapshot.generation!==context.generation)fail('The PDF pending snapshot is stale.')
  // Contract without pageCount: session-deleted pages change setPageOrder's visible permutation.
  const operations=validatePdfApplyOperations(raw),count=context.pageGeometries.length
  const baseOrder=Array.from({length:count},(_,i)=>i),deleted=new Set(snapshot.deleted)
  if(deleted.size!==snapshot.deleted.length||[...deleted].some(p=>!Number.isSafeInteger(p)||p<0||p>=count)||deleted.size>=count)fail('Invalid pending deleted pages.')
  if(snapshot.order!==null&&(snapshot.order.length!==count||new Set(snapshot.order).size!==count||snapshot.order.some(p=>!baseOrder.includes(p))))fail('Invalid pending page order.')
  if(Object.entries(snapshot.rotations).some(([p,r])=>!baseOrder.includes(Number(p))||![0,90,180,270].includes(r)))fail('Invalid pending rotations.')
  let next:PdfPendingSnapshot=structuredClone(snapshot)
  const touched=new Set<PdfPendingBucket>(),saved=new Map(context.savedFields.map(f=>[f.name,f])),names=new Map<string,{kind:string;options:string[]}>()
  if(saved.size!==context.savedFields.length)fail('Ambiguous saved field catalog.')
  for(const f of context.savedFields)names.set(f.name,{kind:f.kind,options:[...(f.options??[])]})
  for(const f of snapshot.formFields){
   const prior=names.get(f.input.name)
   if(prior&&!(prior.kind==='radio'&&f.input.kind==='radio'))fail('Invalid pending field names.')
   names.set(f.input.name,{kind:f.input.kind,options:[...(prior?.options??[]),...(f.input.exportValue?[f.input.exportValue]:[])]})
  }
  const page=(number:number)=>{const p=number-1;if(!Number.isSafeInteger(p)||p<0||p>=count||deleted.has(p))fail('The original PDF page is missing or deleted.');return p}
  function update<K extends PdfPendingBucket>(key:K,value:PdfPendingState[K]){next={...next,[key]:value};touched.add(key)}
  for(const [i,operation]of operations.entries()){
   index=i
   switch(operation.op){
    case 'removeMarkup':update('markups',next.markups.filter(m=>m.id!==operation.id));break
    case 'setNoteContents':update('notes',next.notes.map(n=>n.id===operation.id?{...n,input:{...n.input,contents:operation.contents}}:n));break
    case 'removeTextInsert':update('textInserts',next.textInserts.filter(t=>t.id!==operation.id));break
    case 'setFormValue':{
     const v=operation.value,f=saved.get(v.name)
     if(!f||f.readOnly||f.kind==='signature'||f.kind==='button')fail('The saved PDF field is unavailable or protected.')
     let value:FormValueInput
     if(f.kind==='checkbox'){
      if(typeof v.checked!=='boolean')fail('A checkbox requires checked.')
      value={name:v.name,kind:f.kind,checked:v.checked}
     }else{
      if(typeof v.value!=='string')fail('This field requires a string value.')
      if(f.kind!=='text'&&v.value&&!(f.options??[]).includes(v.value)||f.kind==='text'&&f.maxLen!==undefined&&v.value.length>f.maxLen)fail('The field value is invalid.')
      value={name:v.name,kind:f.kind,value:v.value}
     }
     focusPage??=f.pageIndex+1;update('formEdits',{...next.formEdits,[v.name]:value});break
    }
    case 'addFormField':{
     const f=operation.field,p=page(f.page),prior=names.get(f.name)
     if(saved.get(f.name)?.readOnly)fail('The existing PDF field is read-only.')
     if(/[.\\/]/.test(f.name))fail('PC authored field names cannot contain dots or slashes.')
     if(prior&&!(f.kind==='radio'&&prior.kind==='radio')||[...names.keys()].some(name=>name!==f.name&&(name.startsWith(f.name+'.')||f.name.startsWith(name+'.'))))fail('The PDF field name is already taken.')
     if(f.kind==='radio'&&(!f.exportValue?.trim()||prior?.options.includes(f.exportValue)))fail('The radio export value is missing or already taken.')
     if(f.kind==='choice'&&!f.options?.length)fail('A choice field needs options.')
     const savedGeom=context.pageGeometries[p]!,g={...savedGeom,rot:savedGeom.rot+(snapshot.rotations[p]??0)},size=geomDispSize(g),unit=g.userUnit??1
     if(f.x+f.width>size.width+0.001||f.y+f.height>size.height+0.001||Math.min(f.width,f.height)/unit<1)fail('The field rectangle is outside the page or too small.')
     const a=viewToPdf(g,f.x,f.y),b=viewToPdf(g,f.x+f.width,f.y+f.height),{page:_page,x:_x,y:_y,width:_w,height:_h,...rest}=f
     // PC converts the rectangle only; fontSize passes through to setFontSize unchanged.
     const input:Frozen<FormFieldInput>={...rest,pageIndex:p,rect:[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]}
     names.set(f.name,{kind:f.kind,options:[...(prior?.options??[]),...(f.exportValue?[f.exportValue]:[])]})
     let id=`F${snapshot.generation+1}_${i}`;while(next.formFields.some(f=>f.id===id))id+='_'
     update('formFields',[...next.formFields,{id,input}]);focusPage??=p+1;break
    }
    case 'rotatePages':{
     const indices=operation.pages.map(page),rotations={...next.rotations}
     for(const p of indices){const angle=((rotations[p]??0)+operation.dir+360)%360;if(angle)rotations[p]=angle;else delete rotations[p]}
     update('rotations',rotations);if(indices.length===1)focusPage??=indices[0]!+1;break
    }
    case 'deletePage':{
     const p=page(operation.page);if(count-deleted.size<=1)fail('At least one page must remain.')
     deleted.add(p);update('deleted',[...deleted]);update('markups',next.markups.filter(m=>m.pageIndex!==p));update('notes',next.notes.filter(n=>n.input.pageIndex!==p));update('formFields',next.formFields.filter(f=>f.input.pageIndex!==p));break
    }
    case 'setPageOrder':{
     if(operation.order===null){update('order',null);break}
     const visible=(next.order??baseOrder).filter(p=>!deleted.has(p)),want=operation.order.map(page)
     if(want.length!==visible.length||visible.some(p=>!want.includes(p)))fail('Page order must include every surviving original page exactly once.')
     let moved:number|undefined,shift=0
     want.forEach((p,i)=>{const delta=Math.abs(visible.indexOf(p)-i);if(delta>shift){moved=p;shift=delta}})
     if(moved!==undefined)focusPage??=moved+1
     update('order',[...want,...baseOrder.filter(p=>deleted.has(p))]);break
    }
    case 'setMetadata':update('metadata',operation.metadata===null?null:{...next.metadata,...operation.metadata});break
   }
  }
  if(context.dryRun)return {next:snapshot,touched:[...touched],focusPage,failures:[]}
  next={...next,generation:snapshot.generation+1}
  return {next:freeze(next),touched:[...touched],focusPage,failures:[]}
 }catch(error){return rejected(error)}
}
