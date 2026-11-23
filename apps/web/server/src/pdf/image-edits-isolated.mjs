import {parsePdfImageEditsRequest,parsePdfImageQueryRequest,pdfImageEditsSafetyCodes} from './image-edits-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfImageEditsJob(){return createPdfProcessJob('imageEdits',parsePdfImageEditsRequest,pdfImageEditsSafetyCodes)}
export function createIsolatedPdfImageQueryJob(){return createPdfProcessJob('imageQuery',parsePdfImageQueryRequest,pdfImageEditsSafetyCodes)}
