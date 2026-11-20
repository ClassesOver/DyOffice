import type {PdfAnnotationProcessor} from './annotation-job.mjs'
import type {PdfPageOperation} from '../../../../../packages/web-contracts/src/pdf-page-ops.ts'
export {validatePdfPageOperations} from '../../../../../packages/web-contracts/src/pdf-page-ops.ts'
export const pdfPageOpsSafetyCodes:Set<string>
export function parsePdfPageOpsRequest(raw:unknown):readonly PdfPageOperation[]
export function createPdfPageOpsJob():PdfAnnotationProcessor
