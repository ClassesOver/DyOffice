import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export type PdfPageLayoutOperation={readonly kind:'split';readonly perPage:2|4|9}|{readonly kind:'merge';readonly perSheet:number;readonly direction:'horizontal'|'vertical';readonly separator:boolean}
export const pdfPageLayoutSafetyCodes:Set<string>
export function validatePdfPageLayout(value:unknown):PdfPageLayoutOperation
export function parsePdfPageLayoutRequest(raw:unknown):PdfPageLayoutOperation
export function createPdfPageLayoutJob():PdfAnnotationProcessor
