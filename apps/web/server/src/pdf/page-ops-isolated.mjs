import {parsePdfPageOpsRequest,pdfPageOpsSafetyCodes} from './page-ops-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfPageOpsJob(){return createPdfProcessJob('pageOps',parsePdfPageOpsRequest,pdfPageOpsSafetyCodes)}
