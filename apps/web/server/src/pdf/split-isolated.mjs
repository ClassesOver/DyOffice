import {parsePdfSplitRequest,pdfSplitSafetyCodes} from './split-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfSplitJob(){return createPdfProcessJob('splitPdf',parsePdfSplitRequest,pdfSplitSafetyCodes)}
