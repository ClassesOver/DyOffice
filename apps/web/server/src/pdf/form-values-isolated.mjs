import {parsePdfFormValuesRequest,pdfFormValuesSafetyCodes} from './form-values-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfFormValuesJob(){return createPdfProcessJob('formValues',parsePdfFormValuesRequest,pdfFormValuesSafetyCodes)}
