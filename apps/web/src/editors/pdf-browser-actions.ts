import JSZip from 'jszip'
import {loadPdfForView} from '../../../pdf/src/renderer/open-document'
import type {ExportImagesRequest} from '../../../pdf/src/shared/ipc'
import {browserFileName, downloadBrowserFile} from './browser-download'

export async function readPdfComparisonPages(bytes: Uint8Array, password?: string, signal?: AbortSignal): Promise<string[]> {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('PDF exceeds the comparison size limit.')
  signal?.throwIfAborted()
  const task = loadPdfForView(bytes, password)
  const abort = () => { void task.destroy().catch(() => {}) }
  signal?.addEventListener('abort', abort, {once:true})
  try {
    const pdf = await task.promise
    if (pdf.numPages > 500) throw new Error('PDF exceeds the comparison page limit.')
    const pages: string[] = []
    let characters = 0
    for (let index = 1; index <= pdf.numPages; index++) {
      signal?.throwIfAborted()
      const page = await pdf.getPage(index)
      try {
        const {items} = await page.getTextContent()
        const lines: string[] = []
        for (const item of items) {
          if (!('str' in item)) continue
          characters += item.str.length + Number(item.hasEOL)
          if (characters > 5_000_000) throw new Error('PDF exceeds the comparison text limit.')
          lines.push(item.str)
          if (item.hasEOL) lines.push('\n')
        }
        pages.push(lines.join(''))
      } finally { page.cleanup() }
    }
    return pages
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!signal?.aborted) await task.destroy()
  }
}

export async function downloadPdfImages({images,pageNumbers,format,baseName}:ExportImagesRequest,signal:AbortSignal):Promise<string> {
  if (!images.length || images.length !== pageNumbers.length || new Set(pageNumbers).size !== pageNumbers.length ||
      pageNumbers.some(page=>!Number.isSafeInteger(page)||page<1) ||
      images.reduce((total,image)=>total+image.length,0)>64*1024*1024) throw new Error('PDF image export exceeds its limits.')
  const header = format === 'jpg' ? '/9j/' : 'iVBORw0KGgo'
  const name = browserFileName(baseName, 'document')
  const zip = new JSZip()
  for (const [index, page] of pageNumbers.entries()) {
    signal.throwIfAborted()
    const image = images[index]!
    if (!image.startsWith(header)) throw new Error('PDF image could not be rendered.')
    zip.file(`${name}-${String(page).padStart(2,'0')}.${format}`,image,{base64:true})
  }
  const archive = await zip.generateAsync({type:'blob',compression:'STORE'})
  signal.throwIfAborted()
  const filename = `${name}-${format}.zip`
  downloadBrowserFile(archive,filename)
  return filename
}
