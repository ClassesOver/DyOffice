import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {DrawingInput,MarkupInput} from '../../../pdf/src/shared/ipc'
import type {PdfAnnotation} from '../shell/pdf-preview-skill'
import type {createPdfPendingSession} from './pdf-pending-session'

type QueryResult={revision:string;markups:MarkupInput[];notes:Extract<DrawingInput,{kind:'note'}>[]}
/** Resolve anchors without saving; the canonical session owns all resulting undo history. */
export function createPdfAnnotationDrafts({session,request,isReady}:{session:ReturnType<typeof createPdfPendingSession>;request:SettingsRequest;isReady:()=>boolean}){
 let generation=0,disposed=false
 function check(){if(disposed||!isReady())throw Error('当前不能准备 PDF 批注，请重新操作。')}
 return {
  async append(operations:readonly PdfAnnotation[],signal?:AbortSignal){
   signal?.throwIfAborted();check()
   if(!Array.isArray(operations)||!operations.length||operations.length>20)throw Error('每批需要 1 至 20 项批注操作。')
   const input=structuredClone(operations),token=session.read(),ticket=++generation
   const result=await request<QueryResult>(`/api/v1/files/${encodeURIComponent(token.fileId)}/pdf/annotations/query`,'POST',{revision:token.baseRevision,operations:input},signal)
   signal?.throwIfAborted();check()
   const now=session.read()
   if(ticket!==generation||now.fileId!==token.fileId||now.baseRevision!==token.baseRevision||now.generation!==token.generation)throw Error('PDF 版本或编辑状态已变化，请重新操作。')
   const markupOps=input.filter(op=>op.type!=='note'),noteOps=input.filter(op=>op.type==='note')
   if(!result||result.revision!==token.baseRevision||!Array.isArray(result.markups)||!Array.isArray(result.notes)||result.markups.length!==markupOps.length||result.notes.length!==noteOps.length||result.markups.some((m,i)=>!m||m.pageIndex!==markupOps[i]!.page-1||m.type!==markupOps[i]!.type)||result.notes.some((n,i)=>!n||n.pageIndex!==noteOps[i]!.page-1||n.contents!==noteOps[i]!.contents))throw Error('批注预览结果无效，请重新操作。')
   const prepared={markups:result.markups.map(m=>({...m,id:'P'+crypto.randomUUID()})),notes:result.notes.map(input=>({id:'P'+crypto.randomUUID(),input}))}
   const next=session.appendAnnotations(prepared,token)
   return {markups:next.markups.slice(token.markups.length),notes:next.notes.slice(token.notes.length)}
  },
  dispose(){disposed=true;generation++},
 }
}
