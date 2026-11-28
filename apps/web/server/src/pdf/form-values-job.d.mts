import type {PDFDocument,PDFField} from '../../../../pdf/src/shared/pdf-lib.ts'
import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export interface PdfFormValueOperation {readonly op:'setFormValue';readonly value:{readonly name:string;readonly value?:string;readonly checked?:boolean}}
export const pdfFormValuesSafetyCodes:Set<string>
export function validatePdfFormValueOperations(input:unknown):readonly PdfFormValueOperation[]
export function parsePdfFormValuesRequest(raw:unknown):readonly PdfFormValueOperation[]
export function createPdfFormValuesJob():PdfAnnotationProcessor
export function pdfFormValueFields(doc:PDFDocument):Map<string,PDFField>
export function preparePdfFormValues(doc:PDFDocument,operations:readonly PdfFormValueOperation[]):readonly (PdfFormValueOperation['value']&{kind:'text'|'checkbox'|'radio'|'choice'})[]
export function updatePdfFormValueAppearances(doc:PDFDocument,names:readonly string[],signal?:AbortSignal):Promise<void>
