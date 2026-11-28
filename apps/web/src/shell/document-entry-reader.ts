import type {DocumentFormat} from './document-tabs'
import {CitedRevisionChanged} from '../../../../packages/browser-host/src/session-files'
/** Server capability key that says whether `format` has a native editor (PDF's is named `pdfEditor`). */
export const editorCapabilityKey=(format:string)=>format==='pdf'?'pdfEditor':format==='csv'?'csvImport':format
export function resolvedDocument(capabilities:Record<string,string>,id:string,result:{name:string;format:string;file:{fileId:string;revision:string};downloadEndpoint:string}){
 if(result.file.fileId!==id||!['docx','xlsx','pptx','pdf','csv'].includes(result.format)||typeof result.name!=='string'||typeof result.file.revision!=='string'||!result.file.revision||result.downloadEndpoint!==`/api/v1/files/${encodeURIComponent(id)}/content?revision=${encodeURIComponent(result.file.revision)}`)throw new Error('文件格式或下载地址无效。')
 const native=capabilities[editorCapabilityKey(result.format)]==='editable'
 if(result.format==='pdf'&&!native)throw new Error('当前 PDF 编辑器未启用，请下载原件。')
 if(result.format==='csv'&&!native)throw new Error('当前 Excel 编辑器不支持 CSV，请下载原件。')
 const format=result.format==='csv'?'xlsx':result.format as DocumentFormat
 return {id,name:result.name,format,src:native?`/native-${format}/?fileId=${encodeURIComponent(id)}`:result.downloadEndpoint}
}

type BoundWorkspace={bound:{request:<T=unknown>(path:string,method?:string)=>Promise<T>}}
/** Capture an authenticated workspace; never substitute its unbound client. */
export async function readOpenDocument(workspace:BoundWorkspace,capabilities:Record<string,string>,id:string,sourceRevision?:string){
 const result=await workspace.bound.request<{name:string;format:string;file:{fileId:string;revision:string};downloadEndpoint:string}>(`/api/v1/files/${encodeURIComponent(id)}`)
 const document=resolvedDocument(capabilities,id,result)
 if(sourceRevision!==undefined&&sourceRevision!==result.file.revision)throw new CitedRevisionChanged()
 await workspace.bound.request(`/api/v1/workspace/files/${encodeURIComponent(id)}/open`,'POST')
 if(sourceRevision===undefined)return document
 const src=document.src.startsWith('/native-')?`${document.src}&sourceRevision=${encodeURIComponent(sourceRevision)}`:document.src
 return {...document,src,sourceRevision}
}
