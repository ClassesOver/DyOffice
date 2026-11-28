import { deflateSync, inflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib'

/**
 * Reduce File Size, the parts that are safe without re-rendering anything:
 * every plain FlateDecode stream is inflated and re-deflated at level 9
 * (producers commonly ship level 6, or store already-weak blobs), and Flate
 * images larger than `maxDimension` are downsampled to it with their /Width
 * //Height and /ColorSpace rewritten. Anything else — JPX/CCITT/JPEG streams,
 * predictor-encoded data, image masks — is left byte-identical: a best-effort
 * pass that can only make the file smaller, never broken.
 */

export interface ShrinkResult {
  streamsRecompressed: number
  imagesDownsampled: number
}

export const DEFAULT_MAX_DIMENSION = 2480 // ~300 DPI on A4

/** what a stream must look like before its pixels may be resampled */
interface DownsampleCandidate {
  width: number
  height: number
  channels: number
}

/**
 * An image qualifies only when its decoded bytes can be resampled and
 * re-encoded faithfully: oversized, 8 bits per component, a bare device
 * colour space (arrays like `[/ICCBased …]` or `[/Indexed …]` are not
 * renamable) and a plain Flate payload. An /SMask with a /Matte never
 * qualifies: its dimensions must keep matching the base image's.
 */
function downsampleCandidate(
  doc: PDFDocument,
  dict: PDFDict,
  maxDimension: number,
): DownsampleCandidate | null {
  const width = asInt(dict.get(PDFName.of('Width')))
  const height = asInt(dict.get(PDFName.of('Height')))
  if (width <= 0 || height <= 0 || Math.max(width, height) <= maxDimension) return null
  if (asInt(dict.get(PDFName.of('BitsPerComponent')) ?? 8) !== 8) return null
  // lookupMaybe throws when the object resolves to another type, and array
  // colour spaces (most photo scans) do exactly that — lookup and test instead
  const cs = doc.context.lookup(dict.get(PDFName.of('ColorSpace')))
  const channels = cs instanceof PDFName ? channelCount(cs) : 0
  if (channels === 0) return null
  if (String(dict.get(PDFName.of('Filter'))) !== '/FlateDecode') return null
  if (dict.get(PDFName.of('Matte')) !== undefined) return null
  return { width, height, channels }
}

/** bilinear-free nearest-column/row resample: fast, and for scans visually identical at print size */
export function resamplePixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  newWidth: number,
  newHeight: number,
): Uint8Array {
  const out = new Uint8Array(newWidth * newHeight * channels)
  for (let y = 0; y < newHeight; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / newHeight))
    for (let x = 0; x < newWidth; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / newWidth))
      const src = (sy * width + sx) * channels
      const dst = (y * newWidth + x) * channels
      for (let c = 0; c < channels; c++) out[dst + c] = pixels[src + c]!
    }
  }
  return out
}

function asInt(value: unknown): number {
  const n = Number(String(value ?? '').replace(/^\//, ''))
  return Number.isSafeInteger(n) ? n : 0
}

function decodeFlate(contents: Uint8Array, dict: PDFDict, maxOutputLength?: number): Uint8Array | null {
  // /DecodeParms (predictors) change byte semantics — those streams stay as they are
  if (dict.get(PDFName.of('DecodeParms')) !== undefined) return null
  try {
    return inflateSync(contents, maxOutputLength === undefined ? undefined : { maxOutputLength })
  } catch {
    return null
  }
}

function channelCount(name: PDFName | undefined): 1 | 3 | 4 | 0 {
  // Only bare device names, resolved through the context: a regex over the
  // stringified object matched /DeviceN [/DeviceCMYK …] and recolored the
  // image, while Indexed/Separation/ICCBased passed by accident.
  switch (name?.asString()) {
    case '/DeviceGray':
      return 1
    case '/DeviceRGB':
      return 3
    case '/DeviceCMYK':
      return 4
    default:
      return 0
  }
}

/**
 * Walk every indirect object and shrink what qualifies, in place. Callers save
 * afterwards and compare sizes for themselves.
 */
export function shrinkDocument(
  doc: PDFDocument,
  maxDimension = DEFAULT_MAX_DIMENSION,
  maxInflatedStreamBytes?: number,
): ShrinkResult {
  let streamsRecompressed = 0
  let imagesDownsampled = 0

  const objects = doc.context.enumerateIndirectObjects()
  const softMaskUses = new Map<PDFRef, number>()
  const hardMasks = new Set<PDFRef>()
  for (const [, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue
    if (String(obj.dict.get(PDFName.of('Subtype')) ?? '') !== '/Image') continue
    const mask = obj.dict.get(PDFName.of('SMask'))
    if (mask instanceof PDFRef) softMaskUses.set(mask, (softMaskUses.get(mask) ?? 0) + 1)
    const hardMask = obj.dict.get(PDFName.of('Mask'))
    if (hardMask instanceof PDFRef && doc.context.lookup(hardMask) instanceof PDFRawStream) {
      hardMasks.add(hardMask)
    }
  }
  const downsample = (obj: PDFRawStream, { width, height, channels }: DownsampleCandidate) => {
    const expected = width * height * channels
    if (!Number.isSafeInteger(expected) || expected > (maxInflatedStreamBytes ?? Infinity)) return null
    const decoded = decodeFlate(obj.contents, obj.dict, maxInflatedStreamBytes)
    if (decoded?.length !== expected) return null
    const scale = maxDimension / Math.max(width, height)
    const newWidth = Math.max(1, Math.floor(width * scale))
    const newHeight = Math.max(1, Math.floor(height * scale))
    const pixels = resamplePixels(decoded, width, height, channels, newWidth, newHeight)
    const dict = obj.dict.clone()
    dict.set(PDFName.of('Width'), PDFNumber.of(newWidth))
    dict.set(PDFName.of('Height'), PDFNumber.of(newHeight))
    const packed = deflateSync(pixels, { level: 9 })
    dict.set(PDFName.of('Length'), PDFNumber.of(packed.length))
    return PDFRawStream.of(dict, packed)
  }

  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue
    const dict: PDFDict = obj.dict
    const filter = String(dict.get(PDFName.of('Filter')) ?? '')
    const isImage = String(dict.get(PDFName.of('Subtype')) ?? '') === '/Image'

    if (isImage) {
      const hardMask = dict.get(PDFName.of('Mask'))
      if (softMaskUses.has(ref) || hardMasks.has(ref) ||
          (hardMask !== undefined && !(doc.context.lookup(hardMask) instanceof PDFArray))) continue
      const cand = downsampleCandidate(doc, dict, maxDimension)
      if (!cand) continue
      const mask = dict.get(PDFName.of('SMask'))
      // Prepare both streams before replacing either one. Shared masks and
      // masks with their own masks retain their original geometry.
      if (mask !== undefined) {
        if (!(mask instanceof PDFRef) || softMaskUses.get(mask) !== 1 || hardMasks.has(mask)) continue
        const resolved = doc.context.lookup(mask)
        if (!(resolved instanceof PDFRawStream) || resolved.dict.has(PDFName.of('SMask')) ||
            resolved.dict.has(PDFName.of('Mask'))) continue
        const maskCandidate = downsampleCandidate(doc, resolved.dict, maxDimension)
        if (!maskCandidate || maskCandidate.width !== cand.width || maskCandidate.height !== cand.height) continue
        const scaledMask = downsample(resolved, maskCandidate)
        if (!scaledMask) continue
        const scaled = downsample(obj, cand)
        if (!scaled) continue
        doc.context.assign(mask, scaledMask)
        doc.context.assign(ref, scaled)
        imagesDownsampled += 2
      } else {
        const scaled = downsample(obj, cand)
        if (!scaled) continue
        doc.context.assign(ref, scaled)
        imagesDownsampled++
      }
      continue
    }

    if (filter === '/FlateDecode') {
      const decoded = decodeFlate(obj.contents, dict, maxInflatedStreamBytes)
      if (!decoded) continue
      const packed = deflateSync(decoded, { level: 9 })
      if (packed.length >= obj.contents.length) continue
      doc.context.assign(ref, PDFRawStream.of(dict, packed))
      streamsRecompressed++
    }
  }
  return { streamsRecompressed, imagesDownsampled }
}
