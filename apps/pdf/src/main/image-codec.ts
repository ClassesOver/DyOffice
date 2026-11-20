import { nativeImage } from 'electron'

/** Decode a PNG/JPEG into straight-alpha BGRA (pdfium splits alpha into an SMask itself) */
export function decodeImage(b64: string): { width: number; height: number; bgra: Buffer } {
  const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
  if (img.isEmpty()) throw new Error('could not decode the image data')
  const { width, height } = img.getSize()
  // toBitmap() hands back premultiplied BGRA; un-premultiply so translucent pixels
  // keep their color once pdfium separates them into image + SMask
  const bgra = Buffer.from(img.toBitmap())
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3]!
    if (a > 0 && a < 255) {
      bgra[i] = Math.min(255, Math.round((bgra[i]! * 255) / a))
      bgra[i + 1] = Math.min(255, Math.round((bgra[i + 1]! * 255) / a))
      bgra[i + 2] = Math.min(255, Math.round((bgra[i + 2]! * 255) / a))
    }
  }
  return { width, height, bgra }
}

export function encodeBitmapPng(bgra: Buffer, width: number, height: number): Buffer {
  return nativeImage.createFromBitmap(bgra, { width, height }).toPNG()
}
