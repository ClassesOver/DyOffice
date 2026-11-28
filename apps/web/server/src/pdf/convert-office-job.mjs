import {check, fail, hash, requireEnvelope} from './job-common.mjs'
import {createPdfProcessJob} from './pdf-process-job.mjs'

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
export const pdfConversionFormats = ['docx', 'xlsx', 'pptx', 'md', 'html']
export const pdfOfficeConversionCodes = new Set([
  'INVALID_REQUEST', 'PDF_CONVERSION_LIMIT', 'PDF_COPY_RESTRICTED', 'PDF_CONVERSION_NEEDS_OCR',
  'PDF_CONVERSION_NO_TEXT', 'PASSWORD', 'UNREADABLE', 'OUTPUT_LIMIT',
])

export function parsePdfOfficeConversionRequest(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) fail('INVALID_REQUEST')
  let command
  try { command = JSON.parse(raw) } catch { fail('INVALID_REQUEST') }
  requireEnvelope(command, 'convertOffice', 'operation')
  const {operation} = command
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      Object.keys(operation).some(key => key !== 'format' && key !== 'password' && key !== 'title') ||
      !pdfConversionFormats.includes(operation.format) ||
      (operation.title !== undefined && (operation.format !== 'html' ||
        typeof operation.title !== 'string' || operation.title.length > 255)) ||
      (operation.password !== undefined && (typeof operation.password !== 'string' ||
        operation.password.length > 127 || operation.password.includes('\0')))) fail('INVALID_REQUEST')
  return operation
}

async function exportTextFormat(bytes, format, title) {
  const {ensureDom} = await import('../../../../../packages/cli/src/dom.ts')
  // ProseMirror detects the DOM at module load. Start it before importing
  // the editor used to render the DOCX that the converter just produced.
  await ensureDom()
  const {exportReconstructedDocx} = await import('../../../../docs/src/renderer/reconstructed-docx-export.ts')
  const content = await exportReconstructedDocx(bytes, format, title)
  if (format === 'md' && !content.trim()) fail('PDF_CONVERSION_NO_TEXT')
  return Buffer.from(content, 'utf8')
}

export function createPdfOfficeConversionJob() {
  return {async execute(input, raw, signal) {
    check(signal)
    const {format, password, title = 'Document'} = parsePdfOfficeConversionRequest(raw)
    const textFormat = format === 'md' || format === 'html'
    const target = textFormat ? 'docx' : format
    const [{convertPdfToDocx, convertPdfToPptx, convertPdfToXlsx}, {withPdfDocument, PdfLoadError}, {loadPdfium}] = await Promise.all([
      import('../../../../../packages/pdf2docx/src/index.ts'),
      import('../../../../../packages/pdf2docx/src/extract/pdfium.ts'),
      import('../../../../pdf/src/main/text-edit.ts'),
    ])
    const converters = {docx: convertPdfToDocx, xlsx: convertPdfToXlsx, pptx: convertPdfToPptx}
    const pdfium = await loadPdfium()
    check(signal)
    try {
      withPdfDocument(pdfium, input, doc => {
        // The PDF copy permission is bit 5. PDFium resolves permissions against
        // the supplied password, including the owner role.
        if ((pdfium._FPDF_GetDocPermissions(doc) & 0x10) === 0) fail('PDF_COPY_RESTRICTED')
        const count = pdfium._FPDF_GetPageCount(doc)
        if (count < 1 || count > 100) fail('PDF_CONVERSION_LIMIT')
        let totalPixels = 0
        for (let index = 0; index < count; index++) {
          const page = pdfium._FPDF_LoadPage(doc, index)
          if (!page) fail('UNREADABLE')
          try {
            // Scanned pages can be rasterized at up to 3px per PDF point.
            const width = pdfium._FPDF_GetPageWidthF(page), height = pdfium._FPDF_GetPageHeightF(page)
            const pixels = Math.ceil(width * 3) * Math.ceil(height * 3)
            totalPixels += pixels
            if (!Number.isFinite(pixels) || width <= 0 || height <= 0 ||
                pixels > 24_000_000 || totalPixels > 256_000_000) fail('PDF_CONVERSION_LIMIT')
          } finally {
            pdfium._FPDF_ClosePage(page)
          }
        }
      }, password)
      const result = await converters[target](input, {pdfium, password})
      check(signal)
      if ((format === 'xlsx' || format === 'md') && result.pageResults.some(page => page.status === 'scanned') &&
          result.pageResults.every(page => page.status === 'scanned' || page.status === 'degraded')) {
        fail('PDF_CONVERSION_NEEDS_OCR')
      }
      let output = result[target]
      if (!output.length || output.length > MAX_OUTPUT_BYTES) fail('OUTPUT_LIMIT')
      if (textFormat) output = await exportTextFormat(output, format, title)
      check(signal)
      if (!output.length || output.length > MAX_OUTPUT_BYTES) fail('OUTPUT_LIMIT')
      const bytes = Buffer.from(output.buffer, output.byteOffset, output.byteLength)
      return {bytes, size: bytes.length, inputSha256: hash(input), sha256: hash(bytes)}
    } catch(error) {
      if (error instanceof PdfLoadError) fail(error.code === 'password-required' ? 'PASSWORD' : 'UNREADABLE')
      throw error
    }
  }}
}

export function createIsolatedPdfOfficeConversionJob() {
  return createPdfProcessJob('convertOffice', parsePdfOfficeConversionRequest, pdfOfficeConversionCodes)
}
