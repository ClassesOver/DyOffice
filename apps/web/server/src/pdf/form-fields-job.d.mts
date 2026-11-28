import type {PDFDocument} from '../../../../pdf/src/shared/pdf-lib.ts'
import type {PdfAnnotationProcessor} from './annotation-job.mjs'
import type {PdfFormField,PdfFormFieldOperation} from '../../../../../packages/web-contracts/src/pdf-form-fields.ts'
export {validatePdfFormFieldOperations} from '../../../../../packages/web-contracts/src/pdf-form-fields.ts'
export const pdfFormFieldsSafetyCodes:Set<string>
export function parsePdfFormFieldsRequest(raw:unknown):readonly PdfFormFieldOperation[]
export function createPdfFormFieldsJob():PdfAnnotationProcessor
export type PlannedPdfFormField=Omit<PdfFormField,'page'|'x'|'y'|'width'|'height'|'options'>&{pageIndex:number;rect:[number,number,number,number];options?:string[]}
export function planPdfFormFields(doc:PDFDocument,operations:readonly PdfFormFieldOperation[]):PlannedPdfFormField[]
export function updatePdfFormFieldAppearances(doc:PDFDocument,fields:readonly PlannedPdfFormField[],signal?:AbortSignal):Promise<void>
