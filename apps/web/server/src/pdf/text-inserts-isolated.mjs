import {parsePdfTextInsertsRequest,parsePdfTextInsertsQueryRequest,pdfTextInsertsSafetyCodes} from './text-inserts-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfTextInsertsJob(){return createPdfProcessJob('textInserts',parsePdfTextInsertsRequest,pdfTextInsertsSafetyCodes)}

export function createIsolatedPdfTextInsertsQueryJob(){return createPdfProcessJob('textInsertsQuery',parsePdfTextInsertsQueryRequest,pdfTextInsertsSafetyCodes)}
