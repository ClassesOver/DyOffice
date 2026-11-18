import '@genoffice/ui/tokens.css'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { PDF_OPEN_OPTIONS, PDF_VIEWER_CSP } from './pdf-csp.ts'

export { PDF_VIEWER_CSP }

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let library: Promise<Pdfjs> | undefined

function pdfjs(): Promise<Pdfjs> {
  library ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((loaded) => {
    loaded.GlobalWorkerOptions.workerSrc = workerUrl
    return loaded
  })
  return library
}

/** Draw each page into the host. Annotation, text edit, reorder, and redaction are not offered. */
export async function mountPdfEditor(
  host: HTMLElement,
  bytes: Uint8Array,
  signal?: AbortSignal,
  rotations?: Readonly<Record<number, number>>,
) {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('PDF_RENDER_LIMIT')
  const check = () => { if (signal?.aborted) throw new DOMException('PDF rendering cancelled', 'AbortError') }
  check()
  const lib = await pdfjs()
  check()
  const task = lib.getDocument({
    data: bytes.slice(),
    ...PDF_OPEN_OPTIONS,
    cMapUrl: new URL('/pdfjs/cmaps/', location.origin).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.origin).href,
  })
  let destruction: Promise<void> | undefined
  const destroy = () => destruction ??= Promise.resolve(task.destroy())
  const cancel = () => { void destroy().catch(() => {}) }
  signal?.addEventListener('abort', cancel, {once: true})
  host.replaceChildren()
  const pages: { page: number, width: number, height: number, text: string }[] = []
  try {
    const doc = await task.promise
    check()
    if (doc.numPages > 100) throw new Error('PDF_RENDER_LIMIT')
    let totalPixels = 0
    for (let number = 1; number <= doc.numPages; number += 1) {
      check()
      const page = await doc.getPage(number)
      check()
      const delta = rotations?.[number] ?? 0
      const viewport = delta
        ? page.getViewport({ scale: 1, rotation: (((page.rotate ?? 0) + delta) % 360 + 360) % 360 })
        : page.getViewport({ scale: 1 })
      const pixels = Math.ceil(viewport.width) * Math.ceil(viewport.height)
      totalPixels += pixels
      if (!Number.isFinite(pixels) || viewport.width <= 0 || viewport.height <= 0 || pixels > 16_000_000 || totalPixels > 64_000_000) throw new Error('PDF_RENDER_LIMIT')
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page'
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvas, viewport }).promise
      check()
      const content = await page.getTextContent()
      check()
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join('')
      const caption = document.createElement('p')
      caption.className = 'pdf-text'
      caption.textContent = text
      const figure = document.createElement('figure')
      figure.dataset.pdfPage = String(number)
      figure.append(canvas, caption)
      host.append(figure)
      pages.push({ page: number, width: viewport.width, height: viewport.height, text })
    }
  } catch (error) {
    if (!signal?.aborted) host.replaceChildren()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
    await destroy()
  }
  return { pages }
}
