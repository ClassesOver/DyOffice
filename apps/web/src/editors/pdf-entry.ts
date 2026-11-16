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
export async function mountPdfEditor(host: HTMLElement, bytes: Uint8Array) {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('PDF_RENDER_LIMIT')
  const lib = await pdfjs()
  const task = lib.getDocument({
    data: bytes.slice(),
    ...PDF_OPEN_OPTIONS,
    cMapUrl: new URL('/pdfjs/cmaps/', location.origin).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.origin).href,
  })
  host.replaceChildren()
  const pages: { page: number, width: number, height: number, text: string }[] = []
  try {
    const doc = await task.promise
    if (doc.numPages > 100) throw new Error('PDF_RENDER_LIMIT')
    let totalPixels = 0
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number)
      const viewport = page.getViewport({ scale: 1 })
      const pixels = Math.ceil(viewport.width) * Math.ceil(viewport.height)
      totalPixels += pixels
      if (!Number.isFinite(pixels) || viewport.width <= 0 || viewport.height <= 0 || pixels > 16_000_000 || totalPixels > 64_000_000) throw new Error('PDF_RENDER_LIMIT')
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page'
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvas, viewport }).promise
      const content = await page.getTextContent()
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join('')
      const caption = document.createElement('p')
      caption.className = 'pdf-text'
      caption.textContent = text
      const figure = document.createElement('figure')
      figure.append(canvas, caption)
      host.append(figure)
      pages.push({ page: number, width: viewport.width, height: viewport.height, text })
    }
  } catch (error) {
    host.replaceChildren()
    throw error
  } finally {
    await task.destroy()
  }
  return { pages }
}

function status(message: string) {
  const node = document.querySelector('#status')
  if (node) node.textContent = message
}

async function boot() {
  const view = window as Window & { dyofficeEditorCanClose?: () => boolean, dyofficeEditorDiscard?: () => void }
  view.dyofficeEditorCanClose = () => true
  view.dyofficeEditorDiscard = () => {}
  const file = new URLSearchParams(location.search).get('file') ?? ''
  if (!/^[a-zA-Z0-9-]+$/.test(file)) {
    status('没有可打开的 PDF。')
    return
  }
  const token = sessionStorage.getItem('dyoffice-user-token') ?? ''
  const response = await fetch(`/api/files/${file}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    status('无法打开此 PDF。')
    return
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const host = document.querySelector('#app')
  if (!(host instanceof HTMLElement)) return
  try {
    await mountPdfEditor(host, bytes)
    status('已按原始字节打开。批注、改字、调页和脱敏仍不可用。')
  } catch (error) {
    host.replaceChildren()
    status(error instanceof Error && error.name === 'PasswordException' ? '此 PDF 需要密码，页面不会打开。' : '无法打开此 PDF。')
  }
}

if (typeof document !== 'undefined' && document.body?.dataset.page === 'pdf') void boot()
