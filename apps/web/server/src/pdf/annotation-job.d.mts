export type PdfAnnotationOperation = {
 readonly page:number
 readonly text:string
 readonly occurrence:number
} & ({readonly type:'highlight'|'underline'|'strikeout';readonly contents?:never}|{readonly type:'note';readonly contents:string})
export interface PdfAnnotationResult {
 bytes:Buffer
 inputSha256:string
 sha256:string
 size:number
}
export interface PdfAnnotationProcessor {
 execute(input:Buffer,raw:string,signal?:AbortSignal):Promise<PdfAnnotationResult>
}
export function validatePdfAnnotationOperations(value:unknown):readonly PdfAnnotationOperation[]
export function parsePdfAnnotationRequest(raw:unknown):readonly PdfAnnotationOperation[]
export function createPdfAnnotationJob():PdfAnnotationProcessor

export function planPdfAnnotations(bytes:Uint8Array,operations:readonly PdfAnnotationOperation[],signal?:AbortSignal):Promise<import('./annotations-query-job.mjs').PdfAnnotationsQueryReport>
