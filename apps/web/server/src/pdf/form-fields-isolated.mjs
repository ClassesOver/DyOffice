import {parsePdfFormFieldsRequest,pdfFormFieldsSafetyCodes} from './form-fields-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfFormFieldsJob(){return createPdfProcessJob('formFields',parsePdfFormFieldsRequest,pdfFormFieldsSafetyCodes)}
