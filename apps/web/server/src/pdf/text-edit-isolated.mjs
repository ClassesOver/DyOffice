import {parsePdfTextEditRequest} from './text-edit-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

const safetyCodes=new Set(['MAGIC_MISMATCH','PASSWORD','UNREADABLE','PDF_EDIT_LIMIT','SIGNATURE_EDIT_REFUSED','PDF_EDIT_UNSUPPORTED_STRUCTURE','PDF_TEXT_NOT_FOUND','PDF_TEXT_EDIT_REFUSED','PDF_TEXT_VERIFY_FAILED','OUTPUT_LIMIT'])

export function createIsolatedPdfTextEditJob(){
 return createPdfProcessJob('editText',parsePdfTextEditRequest,safetyCodes)
}
