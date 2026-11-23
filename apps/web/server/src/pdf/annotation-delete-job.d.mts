import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfAnnotationDeleteOperation {readonly page:number;readonly annotationId:string}
export function validatePdfAnnotationDeleteOperations(value:unknown):readonly PdfAnnotationDeleteOperation[]
export function parsePdfAnnotationDeleteRequest(raw:unknown):readonly PdfAnnotationDeleteOperation[]
export function createPdfAnnotationDeleteJob():PdfAnnotationProcessor
