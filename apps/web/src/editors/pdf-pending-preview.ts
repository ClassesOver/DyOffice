import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {PdfPendingSnapshot} from './pdf-pending-ops'

const MAX_BYTES=64*1024*1024
/** Transient preview only. The caller must also reject a changed session generation before mounting. */
export async function queryPdfPendingPreview(request:SettingsRequest,snapshot:PdfPendingSnapshot,signal?:AbortSignal){
 signal?.throwIfAborted()
 const frozen=structuredClone(snapshot),{fileId,baseRevision,generation}=frozen
 const result=await request<{revision:string;generation:number;pdf:string}>(`/api/v1/files/${encodeURIComponent(fileId)}/pdf/apply-ops/query`,'POST',{revision:baseRevision,snapshot:frozen},signal)
 signal?.throwIfAborted()
 const invalid=()=>{throw Error('PDF 待保存预览无效，请重新操作。')}
 if(!result||result.revision!==baseRevision||result.generation!==generation||typeof result.pdf!=='string'||result.pdf.length<8||result.pdf.length>Math.ceil(MAX_BYTES/3)*4||result.pdf.length%4||/[^A-Za-z0-9+/=]/.test(result.pdf))invalid()
 const padding=result.pdf.indexOf('=')
 if(padding>=0&&(padding<result.pdf.length-2||!/^[=]{1,2}$/.test(result.pdf.slice(padding))))invalid()
 let decoded:string
 try{decoded=atob(result.pdf)}catch{return invalid()}
 if(decoded.length>MAX_BYTES||!decoded.startsWith('%PDF-'))invalid()
 const bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0))
 return {revision:baseRevision,generation,bytes}
}
