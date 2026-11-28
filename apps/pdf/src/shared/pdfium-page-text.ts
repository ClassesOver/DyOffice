export interface PdfiumPageTextReader {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
  _FPDFText_GetText(page: number, start: number, count: number, pointer: number): number
}

const utf16le = new TextDecoder('utf-16le', { ignoreBOM: true })

/** Read a PDFium text page, normalizing the line endings for comparison. */
export function readPdfiumPageText(engine: PdfiumPageTextReader, textPage: number, count: number): string {
  if (count <= 0) return ''
  const pointer = engine._malloc((count + 1) * 2)
  if (!pointer) return ''
  try {
    const written = engine._FPDFText_GetText(textPage, 0, count, pointer)
    if (written <= 0) return ''
    return utf16le.decode(engine.HEAPU8.subarray(pointer, pointer + written * 2))
      .replace(/\0+$/, '')
      .replace(/\r\n?/g, '\n')
      .trimEnd()
  } finally {
    engine._free(pointer)
  }
}
