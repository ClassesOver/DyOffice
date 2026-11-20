import {parsePdfBlockEditsRequest,pdfBlockEditsSafetyCodes} from './block-edits-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfBlockEditsJob(){return createPdfProcessJob('blockEdits',parsePdfBlockEditsRequest,pdfBlockEditsSafetyCodes)}
