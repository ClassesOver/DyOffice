const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif'])

async function imageBlob(src: string): Promise<Blob> {
  if (!src.startsWith('data:image/') && !src.startsWith('blob:')) throw Error('Unsupported image source.')
  const response = await fetch(src)
  if (!response.ok) throw Error('Image unavailable.')
  const blob = await response.blob()
  if (!IMAGE_TYPES.has(blob.type) || blob.size > MAX_IMAGE_BYTES) throw Error('Unsupported image.')
  return blob
}

async function pngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw Error('Image conversion unavailable.')
    context.drawImage(bitmap, 0, 0)
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error('Image conversion failed.')), 'image/png'))
    if (png.type !== 'image/png' || png.size > MAX_IMAGE_BYTES) throw Error('Unsupported image.')
    return png
  } finally {
    bitmap.close()
  }
}

export async function copyDocsImageToClipboard(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw Error('Browser clipboard access is unavailable.')
  }
  const png = await pngBlob(await imageBlob(src))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
