import {parsePdfAnnotationDeleteRequest} from './annotation-delete-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

const safetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_ANNOTATION_NOT_FOUND','PDF_ANNOTATION_VERIFY_FAILED','OUTPUT_LIMIT'])

export function createIsolatedPdfAnnotationDeleteJob(){
 return createPdfProcessJob('deleteAnnotations',parsePdfAnnotationDeleteRequest,safetyCodes)
}
