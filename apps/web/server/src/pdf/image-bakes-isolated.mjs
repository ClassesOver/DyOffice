import {parsePdfImageBakesRequest,pdfImageBakesSafetyCodes} from './image-bakes-job.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'
export function createIsolatedPdfImageBakesJob(){return createPdfProcessJob('imageBakes',parsePdfImageBakesRequest,pdfImageBakesSafetyCodes)}
