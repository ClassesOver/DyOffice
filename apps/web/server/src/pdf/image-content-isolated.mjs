import {parsePdfImageContentRequest,pdfImageContentSafetyCodes} from './image-content-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfImageContentJob(){return createPdfProcessJob('imageContent',parsePdfImageContentRequest,pdfImageContentSafetyCodes)}
