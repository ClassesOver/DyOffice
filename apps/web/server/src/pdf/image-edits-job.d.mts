import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfImageInfo {page:number;image_number:number;x:number;y:number;width:number;height:number;layer:'above_text'|'below_text'}
export type PdfImageEditOperation = {op:'transform_image';page:number;image_number:number;x?:number;y?:number;width?:number;height?:number;layer?:'above_text'|'below_text'} | {op:'rotate_image';page:number;image_number:number;direction?:'cw'|'ccw'|'180'} | {op:'delete_image';page:number;image_number:number}
export const pdfImageEditsSafetyCodes:Set<string>
export function validatePdfImageEditOperations(input:unknown):readonly PdfImageEditOperation[]
export function parsePdfImageEditsRequest(raw:unknown):readonly PdfImageEditOperation[]
export function parsePdfImageQueryRequest(raw:unknown):readonly []
export function queryPdfImages(bytes:Buffer,signal?:AbortSignal):Promise<PdfImageInfo[]>
export function createPdfImageEditsJob():PdfAnnotationProcessor
export function createPdfImageQueryJob():PdfAnnotationProcessor
