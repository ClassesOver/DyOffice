import type {PdfAnnotationProcessor} from './annotation-job.mjs'
import type {PdfConvertFormat} from '../../../../pdf/src/shared/ipc.ts'
export interface PdfOfficeConversion {
  format: PdfConvertFormat
  password?: string
}
export const pdfConversionFormats: readonly PdfConvertFormat[]
export const pdfOfficeConversionCodes: ReadonlySet<string>
export function parsePdfOfficeConversionRequest(raw: unknown): PdfOfficeConversion
export function createPdfOfficeConversionJob(): PdfAnnotationProcessor
export function createIsolatedPdfOfficeConversionJob(): PdfAnnotationProcessor
