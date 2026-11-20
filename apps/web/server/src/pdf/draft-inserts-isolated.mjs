import {createPdfProcessJob} from './pdf-process-job.mjs'
import {parsePdfDraftInsertsRequest,pdfDraftInsertsSafetyCodes} from './draft-inserts-job.mjs'
export function createIsolatedPdfImageInsertsQueryJob(){return createPdfProcessJob('imageInsertsQuery',parsePdfDraftInsertsRequest,pdfDraftInsertsSafetyCodes)}
export function createIsolatedPdfDraftInsertsJob(){return createPdfProcessJob('draftInserts',parsePdfDraftInsertsRequest,pdfDraftInsertsSafetyCodes)}

export function createIsolatedPdfDraftInsertsQueryJob(){return createPdfProcessJob('draftInsertsQuery',parsePdfDraftInsertsRequest,pdfDraftInsertsSafetyCodes)}
