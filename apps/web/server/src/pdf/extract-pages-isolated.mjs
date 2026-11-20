import {parsePdfExtractPagesRequest,pdfExtractSafetyCodes} from './extract-pages-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfExtractPagesJob(){return createPdfProcessJob('extractPages',parsePdfExtractPagesRequest,pdfExtractSafetyCodes)}
