import JSZip from 'jszip'
import {exportImageNames} from '../../../slides/src/shared/export-image-names'

export async function downloadSlidesImages(baseName: string, format: 'png' | 'jpg', pages: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const safeName = baseName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').slice(0, 180).replace(/^[.\s]+|[.\s]+$/g, '') || 'slides'
  const archive = new JSZip()
  const header = format === 'png' ? 'iVBORw0KGgo' : '/9j/'
  const names = exportImageNames(safeName, pages.length, format)
  for (const [index, name] of names.entries()) {
    const image = pages[index]!
    if (!image.startsWith(header)) throw new Error('Slide image could not be rendered')
    archive.file(name, image, {base64:true})
  }
  const blob = await archive.generateAsync({type:'blob',compression:'STORE'})
  signal.throwIfAborted()
  const name = `${safeName}-${format}.zip`
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.hidden = true
  document.body.append(link)
  try { link.click() }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0) }
  return name
}
