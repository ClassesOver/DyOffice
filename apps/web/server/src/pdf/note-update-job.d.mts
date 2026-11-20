import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfNoteUpdateOperation {readonly page:number;readonly annotationId:string;readonly action:'reply'|'edit';readonly text:string}
export const pdfNoteUpdateSafetyCodes:Set<string>
export function validatePdfNoteUpdateOperations(value:unknown):readonly PdfNoteUpdateOperation[]
export function parsePdfNoteUpdateRequest(raw:unknown):readonly PdfNoteUpdateOperation[]
export function createPdfNoteUpdateJob():PdfAnnotationProcessor
