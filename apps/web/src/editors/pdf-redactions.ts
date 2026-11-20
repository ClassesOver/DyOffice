import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
export type PdfRedactionCandidate={id:string;page:number;text:string;rect:readonly number[];displayRect:{left:number;top:number;width:number;height:number}}
export type PdfRedactionReview={revision:string;patterns:readonly string[];candidates:PdfRedactionCandidate[];truncated:boolean;scannedPages:number[];unsupportedPages:number[]}
export async function queryPdfRedactions(request:SettingsRequest,fileId:string,revision:string,patterns:readonly string[],signal?:AbortSignal):Promise<PdfRedactionReview>{
 const result=await request<Omit<PdfRedactionReview,'patterns'>>(`/api/v1/files/${encodeURIComponent(fileId)}/pdf/redactions/query`,'POST',{revision,patterns},signal)
 signal?.throwIfAborted()
 if(result.revision!==revision||!Array.isArray(result.candidates)||result.candidates.length>500||typeof result.truncated!=='boolean'||!Array.isArray(result.scannedPages)||!Array.isArray(result.unsupportedPages)||result.candidates.some(item=>!item||typeof item.id!=='string'||!item.id||!Number.isSafeInteger(item.page)||item.page<1||item.page>100||typeof item.text!=='string'||!Array.isArray(item.rect)||item.rect.length!==4||!item.rect.every(Number.isFinite)||!item.displayRect||!Object.values(item.displayRect).every(Number.isFinite)||item.displayRect.width<=0||item.displayRect.height<=0)||new Set(result.candidates.map(item=>item.id)).size!==result.candidates.length)throw Error('无法核对涂黑候选，请重新加载后重试。')
 return {...result,patterns:[...patterns]}
}
