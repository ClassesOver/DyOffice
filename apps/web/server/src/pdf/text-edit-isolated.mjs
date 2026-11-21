import {parsePdfTextEditRequest,pdfTextEditSafetyCodes} from './text-edit-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

export function createIsolatedPdfTextEditJob(){
 return createPdfProcessJob('editText',parsePdfTextEditRequest,pdfTextEditSafetyCodes)
}
