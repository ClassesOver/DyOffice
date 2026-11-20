import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export type PdfImageBakeOperation={op:'flip_image';page:number;image_number:number;axis:'horizontal'|'vertical'}|{op:'set_image_opacity';page:number;image_number:number;opacity:number}|{op:'crop_image';page:number;image_number:number;left?:number;top?:number;right?:number;bottom?:number}|{op:'remove_image_background';page:number;image_number:number;tolerance?:number}
export const pdfImageBakesSafetyCodes:Set<string>
export function validatePdfImageBakeOperation(input:unknown):PdfImageBakeOperation
export function parsePdfImageBakesRequest(raw:unknown):PdfImageBakeOperation
export function createPdfImageBakesJob():PdfAnnotationProcessor
