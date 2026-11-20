import {parsePdfPageLayoutRequest,pdfPageLayoutSafetyCodes} from './page-layout-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfPageLayoutJob(){return createPdfProcessJob('pageLayout',parsePdfPageLayoutRequest,pdfPageLayoutSafetyCodes)}
