import {createPdfProcessJob} from './pdf-process-job.mjs'
import {parsePdfReplacePagesRequest,pdfReplacePagesSafetyCodes} from './replace-pages-job.mjs'
export function createIsolatedPdfReplacePagesJob(){return createPdfProcessJob('replacePages',parsePdfReplacePagesRequest,pdfReplacePagesSafetyCodes)}
