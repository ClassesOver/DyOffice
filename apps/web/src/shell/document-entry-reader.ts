import type {DocumentFormat} from './document-tabs'
/** Server capability key that says whether `format` has a native editor (PDF's is named `pdfEditor`). */
export const editorCapabilityKey=(format:string)=>format==='pdf'?'pdfEditor':format
export function resolvedDocument(capabilities:Record<string,string>,id:string,result:{name:string;format:string;file:{fileId:string;revision:string};downloadEndpoint:string}){
 if(result.file.fileId!==id||!['docx','xlsx','pptx','pdf'].includes(result.format)||typeof result.name!=='string'||typeof result.file.revision!=='string'||!result.file.revision||result.downloadEndpoint!==`/api/v1/files/${encodeURIComponent(id)}/content?revision=${encodeURIComponent(result.file.revision)}`)throw new Error('文件格式或下载地址无效。')
 const native=capabilities[editorCapabilityKey(result.format)]==='editable'
 return {id,name:result.name,format:result.format as DocumentFormat,src:native?`/native-${result.format}/?fileId=${encodeURIComponent(id)}`:result.downloadEndpoint}
}

type BoundWorkspace={bound:{request:<T=unknown>(path:string,method?:string)=>Promise<T>}}
/** Capture an authenticated workspace; never substitute its unbound client. */
export async function readOpenDocument(workspace:BoundWorkspace,capabilities:Record<string,string>,id:string){
 const result=await workspace.bound.request<{name:string;format:string;file:{fileId:string;revision:string};downloadEndpoint:string}>(`/api/v1/files/${encodeURIComponent(id)}`)
 const document=resolvedDocument(capabilities,id,result)
 await workspace.bound.request(`/api/v1/workspace/files/${encodeURIComponent(id)}/open`,'POST')
 return document
}
