import type {PdfAnnotationOperation,PdfAnnotationProcessor} from './annotation-job.mjs'
/** JSON process-boundary data only; do not import desktop IPC/UI types here. */
export interface PdfAnnotationsQueryReport {
 markups:{pageIndex:number;type:'highlight'|'underline'|'strikeout';color:[number,number,number];quads:number[][]}[]
 notes:{kind:'note';pageIndex:number;color:[number,number,number];at:[number,number];contents:string}[]
}
export const annotationsQuerySafetyCodes:Set<string>
export function parsePdfAnnotationsQueryRequest(raw:unknown):readonly PdfAnnotationOperation[]
export function createPdfAnnotationsQueryJob():PdfAnnotationProcessor
