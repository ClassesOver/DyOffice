import {parsePdfStampsRequest,pdfStampsSafetyCodes} from './stamps-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfStampsJob(){return createPdfProcessJob('stamps',parsePdfStampsRequest,pdfStampsSafetyCodes)}
