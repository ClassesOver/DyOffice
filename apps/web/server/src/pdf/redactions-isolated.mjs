import {createPdfProcessJob} from './pdf-process-job.mjs'
import {parsePdfRedactionsRequest,pdfRedactionsSafetyCodes} from './redactions-job.mjs'
export function createIsolatedPdfRedactionsQueryJob(){return createPdfProcessJob('redactionsQuery',parsePdfRedactionsRequest,pdfRedactionsSafetyCodes)}
export function createIsolatedPdfRedactedCopyJob(){return createPdfProcessJob('redactedCopy',parsePdfRedactionsRequest,pdfRedactionsSafetyCodes)}
