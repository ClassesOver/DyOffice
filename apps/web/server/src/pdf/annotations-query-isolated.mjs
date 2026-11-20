import {createPdfProcessJob} from './pdf-process-job.mjs'
import {parsePdfAnnotationsQueryRequest,annotationsQuerySafetyCodes} from './annotations-query-job.mjs'
export function createIsolatedPdfAnnotationsQueryJob(){return createPdfProcessJob('annotationsQuery',parsePdfAnnotationsQueryRequest,annotationsQuerySafetyCodes)}
