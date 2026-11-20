import type {PdfAnnotationProcessor} from './annotation-job.mjs'
import type {PdfApplySnapshot} from './apply-ops-job.mjs'
export const pdfApplyOpsQuerySafetyCodes:Set<string>
export function parsePdfApplyOpsQueryRequest(raw:unknown):PdfApplySnapshot
export function createPdfApplyOpsQueryJob():PdfAnnotationProcessor
