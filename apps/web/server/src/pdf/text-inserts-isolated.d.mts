import type {PdfAnnotationProcessor} from './annotation-job.mjs'
export function createIsolatedPdfTextInsertsJob():PdfAnnotationProcessor

export function createIsolatedPdfTextInsertsQueryJob():ReturnType<typeof import('./text-inserts-job.mjs').createPdfTextInsertsQueryJob>
