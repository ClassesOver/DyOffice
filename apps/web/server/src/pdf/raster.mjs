import { createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PDF_OPEN_OPTIONS } from '../../../src/editors/pdf-csp.ts'
import { inspectPdf } from './capabilities.mjs'

const require = createRequire(new URL('../../../../../package.json', import.meta.url))
const FPDF_BITMAP_BGRA = 4

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status })
}

let pdfiumPromise
function loadPdfium() {
  pdfiumPromise ??= (async () => {
    const { init } = await import('@embedpdf/pdfium')
    const raw = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
    const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    const wrapped = await init({ wasmBinary, thisProgram: 'dyoffice-pdf' })
    const pdfium = wrapped.pdfium ?? wrapped
    pdfium._PDFiumExt_Init()
    return pdfium
  })()
  return pdfiumPromise
}

function rasterPage(pdfium, doc, index) {
  const page = pdfium._FPDF_LoadPage(doc, index)
  if (!page) reject('UNREADABLE')
  const width = Math.max(1, Math.round(pdfium._FPDF_GetPageWidthF(page)))
  const height = Math.max(1, Math.round(pdfium._FPDF_GetPageHeightF(page)))
  const buf = pdfium._malloc(width * height * 4)
  const bitmap = pdfium._FPDFBitmap_CreateEx(width, height, FPDF_BITMAP_BGRA, buf, width * 4)
  if (!bitmap) {
    pdfium._free(buf)
    pdfium._FPDF_ClosePage(page)
    reject('UNREADABLE')
  }
  try {
    pdfium._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
    pdfium._FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
    const pixels = Buffer.from(pdfium.HEAPU8.subarray(buf, buf + width * height * 4))
    let ink = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250) ink += 1
    }
    return { page: index + 1, width, height, ink, pixels: createHash('sha256').update(pixels).digest('hex') }
  } finally {
    pdfium._FPDFBitmap_Destroy(bitmap)
    pdfium._free(buf)
    pdfium._FPDF_ClosePage(page)
  }
}

// Preflight the whole document before allocating any bitmap, so a late large
// page cannot consume resources after earlier pages have already been rendered.
function validateRasterBudget(pdfium, doc) {
  const count = pdfium._FPDF_GetPageCount(doc)
  if (!Number.isInteger(count) || count < 1 || count > 100) reject('PDF_RENDER_LIMIT')
  let total = 0
  for (let index = 0; index < count; index += 1) {
    const page = pdfium._FPDF_LoadPage(doc, index)
    if (!page) reject('UNREADABLE')
    try {
      const width = pdfium._FPDF_GetPageWidthF(page)
      const height = pdfium._FPDF_GetPageHeightF(page)
      const pixels = Math.ceil(width) * Math.ceil(height)
      if (!Number.isFinite(pixels) || width <= 0 || height <= 0 || pixels > 16_000_000 || pixels > 64_000_000 - total) reject('PDF_RENDER_LIMIT')
      total += pixels
    } finally {
      pdfium._FPDF_ClosePage(page)
    }
  }
  return count
}

async function withDocument(pdfium, bytes, fn) {
  const ptr = pdfium._malloc(bytes.length)
  pdfium.HEAPU8.set(bytes, ptr)
  const doc = pdfium._FPDF_LoadMemDocument(ptr, bytes.length, 0)
  if (!doc) {
    pdfium._free(ptr)
    reject('UNREADABLE')
  }
  try {
    return await fn(doc)
  } finally {
    pdfium._FPDF_CloseDocument(doc)
    pdfium._free(ptr)
  }
}

async function pageText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), ...PDF_OPEN_OPTIONS, cMapUrl: join(dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps') + sep, cMapPacked: true, standardFontDataUrl: join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + sep })
  try {
    const doc = await task.promise
    const texts = []
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number)
      const content = await page.getTextContent()
      texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
    }
    return texts
  } finally {
    await task.destroy()
  }
}

/**
 * Rasterize with PDFium and read text with PDF.js. The returned pixel hash is
 * the reopen check for an unchanged export. Encrypted files produce no pixels.
 */
export async function renderPdfPages(bytes) {
  if (bytes.byteLength > 64 * 1024 * 1024) reject('PDF_RENDER_LIMIT')
  const report = await inspectPdf(bytes)
  if (report.encrypted) return { encrypted: true, pages: [] }
  const pdfium = await loadPdfium()
  const pages = await withDocument(pdfium, bytes, async (doc) => {
    const count = validateRasterBudget(pdfium, doc)
    const rendered = []
    for (let index = 0; index < count; index += 1) rendered.push(rasterPage(pdfium, doc, index))
    return rendered
  })
  const texts = await pageText(bytes)
  return {
    encrypted: false,
    pages: pages.map((page, index) => ({ ...page, text: texts[index] ?? '' })),
  }
}
