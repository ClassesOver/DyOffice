import type {PdfAnnotationProcessor} from './annotation-job.mjs'
import type {PdfStampOperation} from '../../../../../packages/web-contracts/src/pdf-stamp-ops.ts'
import type {PDFDocument} from 'pdf-lib'
export const pdfStampsSafetyCodes:Set<string>
export function parsePdfStampsRequest(raw:unknown):PdfStampOperation
export function createPdfStampsJob():PdfAnnotationProcessor

export function capturePdfManagedStamps(input:Uint8Array,options?:{allowAcroForm?:boolean}):Promise<{bytes:Buffer;operations:PdfStampOperation[]}>
export function reapplyPdfManagedStamps(input:Uint8Array,operations:PdfStampOperation[],options?:{allowAcroForm?:boolean;signal?:AbortSignal}):Promise<Buffer>
export function preservePdfManagedStamps(input:Uint8Array,output:Uint8Array,options?:{allowAcroForm?:boolean;pending?:boolean}):Promise<Buffer>
export function assertPdfManagedStamps(doc:PDFDocument):void
