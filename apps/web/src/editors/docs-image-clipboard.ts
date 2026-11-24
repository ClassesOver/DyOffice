import { decodeBrowserBase64 } from './browser-download.ts'

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10_000
const CLIPBOARD_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif'])
const IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'],
  ['image/webp', 'webp'], ['image/avif', 'avif'], ['image/bmp', 'bmp'],
])

async function readResponseImage(response: Response): Promise<Blob> {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
  if (!response.ok || !response.body || !IMAGE_EXTENSIONS.has(type)
    || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel()
    throw Error('Image unavailable.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()
        throw Error('Unsupported image size.')
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
  if (!size) throw Error('Empty image.')
  return new Blob(chunks, { type })
}

async function canvasPng(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw Error('Unsupported image dimensions.')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw Error('Image conversion unavailable.')
  context.drawImage(source, 0, 0)
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(Error('Image conversion failed.')), 'image/png')
  })
  if (png.type !== 'image/png' || png.size > MAX_IMAGE_BYTES) throw Error('Unsupported image.')
  return png
}

async function readExternalImage(url: string): Promise<Blob> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.referrerPolicy = 'no-referrer'
  image.src = url
  const timeout = setTimeout(() => image.removeAttribute('src'), IMAGE_TIMEOUT_MS)
  try {
    await image.decode()
    return await canvasPng(image, image.naturalWidth, image.naturalHeight)
  } finally {
    clearTimeout(timeout)
    image.removeAttribute('src')
  }
}

async function readImage(src: string): Promise<Blob> {
  const data = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(src)
  if (data) {
    const type = data[1].toLowerCase()
    const encoded = src.slice(data[0].length)
    if (!IMAGE_EXTENSIONS.has(type) || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw Error('Unsupported image.')
    const bytes = decodeBrowserBase64(encoded)
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Error('Unsupported image size.')
    return new Blob([bytes], { type })
  }

  const url = new URL(src, window.location.href)
  const sameOrigin = url.origin === window.location.origin
  if (url.username || url.password) throw Error('Unsupported image URL.')
  if ((url.protocol === 'blob:' && sameOrigin)
    || (sameOrigin && (url.protocol === 'https:' || url.protocol === 'http:'))) {
    return readResponseImage(await fetch(url.href, {
      credentials: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    }))
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && new URL(window.location.href).protocol === 'http:')) {
    return readExternalImage(url.href)
  }
  throw Error('Unsupported image source.')
}

async function pngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    return await canvasPng(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

export async function readDocsImage(src: string): Promise<{ blob: Blob; extension: string }> {
  const blob = await readImage(src)
  const extension = IMAGE_EXTENSIONS.get(blob.type)
  if (!extension) throw Error('Unsupported image.')
  return { blob, extension }
}

export async function fetchDocsClipboardImage(src: string): Promise<{ base64: string; mime: string }> {
  const blob = await readImage(src)
  const image = CLIPBOARD_TYPES.has(blob.type) ? blob : await pngBlob(blob)
  const bytes = new Uint8Array(await image.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  }
  return { base64: btoa(binary), mime: image.type }
}

export async function copyDocsImageToClipboard(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw Error('Browser clipboard access is unavailable.')
  }
  const png = await pngBlob(await readImage(src))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
