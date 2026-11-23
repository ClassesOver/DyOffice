import {createPdfProcessJob} from './pdf-process-job.mjs'
import {parsePdfApplyOpsQueryRequest,pdfApplyOpsQuerySafetyCodes} from './apply-ops-query-job.mjs'
export function createIsolatedPdfApplyOpsQueryJob(){return createPdfProcessJob('applyOpsQuery',parsePdfApplyOpsQueryRequest,pdfApplyOpsQuerySafetyCodes)}
