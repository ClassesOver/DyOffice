import {parsePdfAnnotationRequest} from './annotation-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

const safetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_TEXT_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','OUTPUT_LIMIT'])

export function createIsolatedPdfAnnotationJob(){
 return createPdfProcessJob('annotateText',parsePdfAnnotationRequest,safetyCodes)
}
