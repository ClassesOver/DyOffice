import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export type PdfImageContentOperation = {op:'insert_image';page:number;image:{base64:string;mime:'image/png'|'image/jpeg'};anchor_text?:string;placement?:'above'|'below'|'left'|'right';x?:number;y?:number;width?:number;layer?:'above_text'|'below_text'} | {op:'replace_image';page:number;image_number:number;image:{base64:string;mime:'image/png'|'image/jpeg'}}
export const pdfImageContentSafetyCodes:Set<string>
export function validatePdfImageContentOperation(input:unknown):PdfImageContentOperation
export function parsePdfImageContentRequest(raw:unknown):PdfImageContentOperation
export function decodePdfImage(image:{base64:string;mime:string}):{width:number;height:number;bgra:Buffer}
export function createPdfImageContentJob():PdfAnnotationProcessor

export function planPdfImageContent(bytes:Buffer,operation:PdfImageContentOperation,decoded:{width:number;height:number},signal?:AbortSignal,independentHeight?:number,rotationDelta?:number):Promise<any>
