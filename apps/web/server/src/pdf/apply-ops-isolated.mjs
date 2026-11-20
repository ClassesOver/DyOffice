import {parsePdfApplyOpsRequest,pdfApplyOpsSafetyCodes} from './apply-ops-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfApplyOpsJob(){return createPdfProcessJob('applyOps',parsePdfApplyOpsRequest,pdfApplyOpsSafetyCodes)}
