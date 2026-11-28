import { MARKDOWN_IMAGE_EXTENSIONS, MARKDOWN_MEDIA_DIR_TOKEN, type MarkdownImage } from '../../../docs/src/shared/ipc.ts'
import { browserFileName, decodeBrowserBase64 } from './browser-download.ts'

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_EXPORT_BYTES = 32 * 1024 * 1024
const MAX_IMAGES = 4094
// The editor escapes the marker in prose and emits it only in picture destinations.
const mediaReference = new RegExp(String.raw`!\[((?:\\[^\r\n]|[^\]\\\r\n])*)\]\(${MARKDOWN_MEDIA_DIR_TOKEN}/(image[1-9]\d{0,5}\.[a-z0-9]+)\)`, 'g')

function markdownSections(markdown: string): { text: string; fenced: boolean }[] {
  const sections: { text: string; fenced: boolean }[] = []
  let offset = 0
  // The renderer chooses a backtick run longer than any run in the code block.
  for (const block of markdown.matchAll(/^(`{3,})\r?\n[\s\S]*?^\1(?:\r?\n|$)/gm)) {
    sections.push({ text: markdown.slice(offset, block.index), fenced: false }, { text: block[0], fenced: true })
    offset = block.index + block[0].length
  }
  sections.push({ text: markdown.slice(offset), fenced: false })
  return sections
}

function safeBaseName(name: string): string {
  const cleaned = browserFileName(name, 'Document').replace(/\p{Cs}/gu, '_')
  // Leave room for the media directory suffix under extraction tools' 255-byte name limit.
  const base = Array.from(cleaned).slice(0, 60).join('').replace(/[.\s]+$/g, '') || 'Document'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base
}

interface EmbeddedImage { extension: string; bytes: ArrayBuffer }

function dataImage(src: string, limit: number): EmbeddedImage | undefined {
  const comma = src.indexOf(',')
  if (comma < 0 || comma > 100 || src.length - comma - 1 > Math.ceil(limit / 3) * 4) return undefined
  const mime = /^data:(image\/[\w.+-]+);base64$/i.exec(src.slice(0, comma))?.[1]?.toLowerCase()
  const extension = mime && MARKDOWN_IMAGE_EXTENSIONS[mime]
  if (!extension) return undefined
  const decoded = decodeBrowserBase64(src.slice(comma + 1))
  if (!decoded.length || decoded.length > limit) return undefined
  return { extension, bytes: decoded.buffer }
}

async function readImage(src: string, limit: number, origin: string): Promise<EmbeddedImage | undefined> {
  if (src.startsWith('data:')) return dataImage(src, limit)
  if (!src.startsWith('blob:') || !origin || new URL(src).origin !== origin) return undefined
  const response = await fetch(src, { mode: 'same-origin', redirect: 'error' })
  if (!response.ok || Number(response.headers.get('content-length')) > limit) return undefined
  const blob = await response.blob()
  const extension = MARKDOWN_IMAGE_EXTENSIONS[blob.type.split(';', 1)[0] ?? '']
  if (!extension || !blob.size || blob.size > limit) return undefined
  return { extension, bytes: await blob.arrayBuffer() }
}

export async function prepareMarkdownDownload(
  name: string,
  markdown: string,
  images: readonly MarkdownImage[],
  origin: string,
): Promise<{ name: string; blob: Blob; imagesDropped: number }> {
  if (markdown.length > MAX_EXPORT_BYTES || images.length > MAX_IMAGES) throw new RangeError('Markdown export is too large.')
  const original = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  if (original.size > MAX_EXPORT_BYTES) throw new RangeError('Markdown export is too large.')
  const base = safeBaseName(name)
  const markdownName = `${base}.md`
  if (!images.length) return { name: markdownName, blob: original, imagesDropped: 0 }

  const sections = markdownSections(markdown)
  const wanted = new Set<string>()
  for (const section of sections) {
    if (section.fenced) continue
    for (const match of section.text.matchAll(mediaReference)) wanted.add(match[2]!)
  }
  const attached = new Map<string, { bytes: ArrayBuffer; name: string }>()
  let mediaBytes = 0
  for (const image of images) {
    if (!wanted.has(image?.name) || attached.has(image.name) || typeof image.src !== 'string') continue
    const limit = Math.min(MAX_IMAGE_BYTES, MAX_EXPORT_BYTES - original.size - mediaBytes)
    if (limit < 1) break
    const asset = await readImage(image.src, limit, origin).catch(() => undefined)
    if (!asset) continue
    attached.set(image.name, { bytes: asset.bytes, name: `image${attached.size + 1}.${asset.extension}` })
    mediaBytes += asset.bytes.byteLength
  }

  const folder = `${base}_files`
  const destination = encodeURIComponent(folder).replace(/[()]/g, value => value === '(' ? '%28' : '%29')
  const content = sections.map(section => section.fenced ? section.text :
    section.text.replace(mediaReference, (_match, alt: string, source: string) => {
      const image = attached.get(source)
      return image ? `![${alt}](${destination}/${image.name})` : alt
    }),
  ).join('')
  const plain = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  if (mediaBytes + plain.size > MAX_EXPORT_BYTES) throw new RangeError('Markdown export is too large.')
  const imagesDropped = images.length - attached.size
  if (!attached.size) return { name: markdownName, blob: plain, imagesDropped }

  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file(markdownName, content)
  for (const image of attached.values()) zip.file(`${folder}/${image.name}`, image.bytes)
  const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new RangeError('Markdown export is too large.')
  return { name: `${base}.zip`, blob: new Blob([bytes], { type: 'application/zip' }), imagesDropped }
}
