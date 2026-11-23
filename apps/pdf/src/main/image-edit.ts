import {
  FPDF_PAGEOBJ_TEXT,
  chainPdfium,
  eraseTextRuns,
  loadPdfium,
  saveDoc,
  withDocument,
} from './text-edit'
import type { Pdfium } from './text-edit'
import {
  SHARED_TEMPLATE_IMAGE_REASON,
  chainIsExclusive,
  formDrawTree,
  liftOutOfForms,
  transformRect,
  concatMat,
  walkPageText,
} from './form-text'
import type { FormChain, FormDrawTree } from './form-text'
import type {
  ImageEditFailure,
  ImageEditInput,
  PageImageRef,
  PagePreviewRequest,
  PagePreviewResult,
} from '../shared/ipc'

const FPDF_PAGEOBJ_IMAGE = 3
const FPDF_BITMAP_BGRA = 4

export type ImageDecoder = (base64: string) => { width: number; height: number; bgra: Buffer }
type ImageEncoder = (bgra: Buffer, width: number, height: number) => Buffer
async function decodeBitmap(base64: string, decoder?: ImageDecoder) {
  return decoder ? decoder(base64) : (await import('./image-codec')).decodeImage(base64)
}

type Rect = readonly [number, number, number, number]

interface PageObj {
  obj: number
  index: number
  type: number
  bounds: [number, number, number, number]
}

/** An image object, page-owned or drawn inside a Form XObject (bounds in page space) */
interface ImageObj {
  obj: number
  /** Page object index; for template images, their top-level ancestor's */
  index: number
  bounds: [number, number, number, number]
  chain: FormChain
  ordinals: readonly number[]
}

function collectObjects(m: Pdfium, page: number): PageObj[] {
  const out: PageObj[] = []
  const bl = m._malloc(4)
  const bb = m._malloc(4)
  const br = m._malloc(4)
  const bt = m._malloc(4)
  const count = m._FPDFPage_CountObjects(page)
  for (let i = 0; i < count; i++) {
    const obj = m._FPDFPage_GetObject(page, i)
    if (!m._FPDFPageObj_GetBounds(obj, bl, bb, br, bt)) continue
    out.push({
      obj,
      index: i,
      type: m._FPDFPageObj_GetType(obj),
      bounds: [m.HEAPF32[bl >> 2]!, m.HEAPF32[bb >> 2]!, m.HEAPF32[br >> 2]!, m.HEAPF32[bt >> 2]!],
    })
  }
  for (const p of [bl, bb, br, bt]) m._free(p)
  return out
}

function imageObjectMatrix(m: Pdfium, object: number): readonly [number,number,number,number,number,number] {
  const ptr = m._malloc(24)
  try {
    if (!m._FPDFPageObj_GetMatrix(object, ptr)) throw new Error('image matrix unavailable')
    return Array.from(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + 6)) as [number,number,number,number,number,number]
  } finally { m._free(ptr) }
}

function collectImages(m: Pdfium, page: number): ImageObj[] {
  const out: ImageObj[] = []
  const bl = m._malloc(4)
  const bb = m._malloc(4)
  const br = m._malloc(4)
  const bt = m._malloc(4)
  walkPageText(m, page, FPDF_PAGEOBJ_IMAGE, ({ obj, chain, ordinals, topIndex, toPage }) => {
    if (!m._FPDFPageObj_GetBounds(obj, bl, bb, br, bt)) return
    out.push({
      obj,
      index: topIndex,
      bounds: transformRect([0, 0, 1, 1], concatMat(imageObjectMatrix(m, obj), toPage)),
      chain,
      ordinals,
    })
  })
  for (const p of [bl, bb, br, bt]) m._free(p)
  return out
}

/** Bounds travel renderer→main unchanged, so matching is tight; the tolerance only
    absorbs float32 round-trips. Closest candidate within tolerance wins. */
const MATCH_TOL = 2

function matchImage(objects: ImageObj[], rect: Rect): ImageObj | null {
  let best: ImageObj | null = null
  let bestD = Infinity
  for (const o of objects) {
    const d = Math.max(
      Math.abs(o.bounds[0] - rect[0]),
      Math.abs(o.bounds[1] - rect[1]),
      Math.abs(o.bounds[2] - rect[2]),
      Math.abs(o.bounds[3] - rect[3]),
    )
    if (d <= MATCH_TOL && d < bestD) {
      best = o
      bestD = d
    }
  }
  return best
}

const firstTextIndex = (objects: PageObj[]): number | undefined =>
  objects.find((o) => o.type === FPDF_PAGEOBJ_TEXT)?.index

/** Lazy per-document census of how often each Form XObject is painted */
type FormExclusive = (pageIndex: number, img: ImageObj) => Promise<boolean>

function formExclusivity(bytes: Uint8Array): FormExclusive {
  let tree: Promise<FormDrawTree> | null = null
  return async (pageIndex, img) => {
    if (img.chain.length === 0) return true
    tree ??= formDrawTree(bytes)
    return chainIsExclusive(await tree, pageIndex, img.ordinals)
  }
}

interface EditGuard {
  exclusive: FormExclusive
  pageIndex: number
}

/** Locate the image under `rect`; a template image is lifted to page level first (as
    the text path does) so the page-owned ops below apply unchanged. Without an
    exclusivity check (preview/render on an in-memory copy) the lift is unconditional. */
async function resolveImage(
  m: Pdfium,
  page: number,
  rect: Rect,
  guard?: EditGuard,
): Promise<ImageObj> {
  const target = matchImage(collectImages(m, page), rect)
  if (!target) throw new Error('the image could not be located on the page')
  if (target.chain.length > 0) {
    if (guard && !(await guard.exclusive(guard.pageIndex, target))) {
      throw new Error(SHARED_TEMPLATE_IMAGE_REASON)
    }
    liftOutOfForms(m, page, target.obj, target.chain)
    target.chain = []
  }
  return target
}

/** Content matrix for a footprint rect, counter-rotated against the page's display
    rotation so the image shows upright (same table as save-pdf's addImageStamp) */
export function imageMatrix(rect: Rect, rotate: number): number[] {
  const [x1, y1, x2, y2] = rect
  const w = x2 - x1
  const h = y2 - y1
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [0, h, -w, 0, x2, y1]
    case 180:
      return [-w, 0, 0, -h, x2, y2]
    case 270:
      return [0, -h, w, 0, x1, y2]
    default:
      return [w, 0, 0, h, x1, y1]
  }
}

async function insertImage(m: Pdfium, doc: number, page: number, edit: ImageEditInput, decoder?: ImageDecoder): Promise<void> {
  if (edit.kind !== 'insertImage') return
  const { width, height, bgra } = await decodeBitmap(edit.image, decoder)
  const bufPtr = m._malloc(bgra.length)
  m.HEAPU8.set(bgra, bufPtr)
  const bmp = m._FPDFBitmap_CreateEx(width, height, FPDF_BITMAP_BGRA, bufPtr, width * 4)
  if (!bmp) {
    m._free(bufPtr)
    throw new Error('FPDFBitmap_CreateEx failed')
  }
  const imgObj = m._FPDFPageObj_NewImageObj(doc)
  const ok = imgObj && m._FPDFImageObj_SetBitmap(0, 0, imgObj, bmp)
  m._FPDFBitmap_Destroy(bmp)
  m._free(bufPtr)
  if (!ok) {
    if (imgObj) m._FPDFPageObj_Destroy(imgObj)
    throw new Error('FPDFImageObj_SetBitmap failed')
  }
  const matPtr = m._malloc(24)
  m.HEAPF32.set(imageMatrix(edit.rect, edit.rotate ?? 0), matPtr >> 2)
  m._FPDFPageObj_SetMatrix(imgObj, matPtr)
  m._free(matPtr)
  const textIdx = edit.layer === 'belowText' ? firstTextIndex(collectObjects(m, page)) : undefined
  if (textIdx !== undefined && m._FPDFPage_InsertObjectAtIndex) {
    if (!m._FPDFPage_InsertObjectAtIndex(page, imgObj, textIdx)) {
      m._FPDFPageObj_Destroy(imgObj)
      throw new Error('FPDFPage_InsertObjectAtIndex failed')
    }
  } else {
    m._FPDFPage_InsertObject(page, imgObj)
  }
}

/** Move an object to the requested z-band (remove + reinsert; the page owns it again after) */
function moveToLayer(m: Pdfium, page: number, obj: number, layer: 'belowText' | 'aboveText'): void {
  if (!m._FPDFPage_RemoveObject(page, obj)) throw new Error('FPDFPage_RemoveObject failed')
  const textIdx = layer === 'belowText' ? firstTextIndex(collectObjects(m, page)) : undefined
  if (textIdx !== undefined && m._FPDFPage_InsertObjectAtIndex) {
    if (!m._FPDFPage_InsertObjectAtIndex(page, obj, textIdx)) {
      // The object is already off the page here — re-attach it (topmost) instead of
      // destroying it, or a skipped layer change would silently delete page content
      m._FPDFPage_InsertObject(page, obj)
      throw new Error('FPDFPage_InsertObjectAtIndex failed')
    }
  } else {
    m._FPDFPage_InsertObject(page, obj)
  }
}

/** Screen-clockwise quarter turns as PDF user-space matrices (y-up flips handedness) */
const QUARTER_TURN_MATS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, 0, 1],
  [0, -1, 1, 0],
  [-1, 0, 0, -1],
  [0, 1, -1, 0],
]

/** Optional center rotation, then the axis-aligned map old bounds → final rect
    (content orientation otherwise survives, as before) */
function applyImageGeometry(
  m: Pdfium,
  obj: number,
  bounds: Rect,
  rect: Rect,
  quarterTurns?: number,
): void {
  let [ox1, oy1, ox2, oy2] = bounds
  const turns = (((quarterTurns ?? 0) % 4) + 4) % 4
  if (turns) {
    const cx = (ox1 + ox2) / 2
    const cy = (oy1 + oy2) / 2
    const [a, b, c, d] = QUARTER_TURN_MATS[turns]!
    m._FPDFPageObj_Transform(obj, a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy)
    if (turns % 2 === 1) {
      const w = ox2 - ox1
      const h = oy2 - oy1
      ;[ox1, oy1, ox2, oy2] = [cx - h / 2, cy - w / 2, cx + h / 2, cy + w / 2]
    }
  }
  const [nx1, ny1, nx2, ny2] = rect
  const ow = ox2 - ox1
  const oh = oy2 - oy1
  if (ow > 1e-6 && oh > 1e-6 && (nx1 !== ox1 || ny1 !== oy1 || nx2 !== ox2 || ny2 !== oy2)) {
    const sx = (nx2 - nx1) / ow
    const sy = (ny2 - ny1) / oh
    // Post-multiplied axis-aligned map old bounds → new rect
    m._FPDFPageObj_Transform(obj, sx, 0, 0, sy, nx1 - sx * ox1, ny1 - sy * oy1)
  }
}

async function transformImage(
  m: Pdfium,
  page: number,
  edit: ImageEditInput,
  guard: EditGuard,
): Promise<void> {
  if (edit.kind !== 'transformImage') return
  const target = await resolveImage(m, page, edit.oldRect, guard)
  // Layer move first: it is the only part that can fail, so a skipped edit is
  // reported before any geometry has been touched
  if (edit.layer) moveToLayer(m, page, target.obj, edit.layer)
  applyImageGeometry(m, target.obj, target.bounds, edit.rect, edit.quarterTurns)
}

/** Swap the image object's pixels for a new bitmap (matrix untouched: the footprint,
    z-order and any original rotation stay), then apply the shared geometry pass */
async function replaceImage(
  m: Pdfium,
  page: number,
  edit: ImageEditInput,
  guard: EditGuard,
  decoder?: ImageDecoder,
): Promise<void> {
  if (edit.kind !== 'replaceImage') return
  const target = await resolveImage(m, page, edit.oldRect, guard)
  if (edit.layer) moveToLayer(m, page, target.obj, edit.layer)
  const { width, height, bgra } = await decodeBitmap(edit.image, decoder)
  const bufPtr = m._malloc(bgra.length)
  m.HEAPU8.set(bgra, bufPtr)
  const bmp = m._FPDFBitmap_CreateEx(width, height, FPDF_BITMAP_BGRA, bufPtr, width * 4)
  if (!bmp) {
    m._free(bufPtr)
    throw new Error('FPDFBitmap_CreateEx failed')
  }
  // Pass the owning page so pdfium drops its cached render of the old pixels
  const pagesPtr = m._malloc(4)
  m.HEAP32[pagesPtr >> 2] = page
  const ok = m._FPDFImageObj_SetBitmap(pagesPtr, 1, target.obj, bmp)
  m._free(pagesPtr)
  m._FPDFBitmap_Destroy(bmp)
  m._free(bufPtr)
  if (!ok) throw new Error('FPDFImageObj_SetBitmap failed')
  applyImageGeometry(m, target.obj, target.bounds, edit.rect, edit.quarterTurns)
}

async function deleteImage(
  m: Pdfium,
  page: number,
  edit: ImageEditInput,
  guard: EditGuard,
): Promise<void> {
  if (edit.kind !== 'deleteImage') return
  const target = await resolveImage(m, page, edit.oldRect, guard)
  if (!m._FPDFPage_RemoveObject(page, target.obj)) throw new Error('FPDFPage_RemoveObject failed')
  m._FPDFPageObj_Destroy(target.obj)
}

export interface ImageEditsResult {
  bytes: Uint8Array
  skipped: ImageEditFailure[]
}

/** Apply content-stream image ops, fail-soft per edit (mirrors applyTextEdits) */
export function applyImageEdits(
  bytes: Uint8Array,
  edits: ImageEditInput[],
  decoder?: ImageDecoder,
): Promise<ImageEditsResult> {
  return chainPdfium(async () => {
    const m = await loadPdfium()
    const skipped: ImageEditFailure[] = []
    const exclusive = formExclusivity(bytes)
    return withDocument(m, bytes, async (doc) => {
      const pageCount = m._FPDF_GetPageCount(doc)
      const byPage = new Map<number, { edit: ImageEditInput; editIndex: number }[]>()
      for (const [editIndex, edit] of edits.entries()) {
        if (edit.pageIndex < 0 || edit.pageIndex >= pageCount) {
          skipped.push({ editIndex, pageIndex: edit.pageIndex, reason: 'page does not exist' })
          continue
        }
        byPage.set(edit.pageIndex, [...(byPage.get(edit.pageIndex) ?? []), { edit, editIndex }])
      }
      let appliedTotal = 0
      for (const [pageIndex, pageEdits] of byPage) {
        const page = m._FPDF_LoadPage(doc, pageIndex)
        if (!page) throw new Error(`could not load page ${pageIndex + 1}`)
        try {
          let applied = 0
          const guard = { exclusive, pageIndex }
          // Objects are re-collected inside each op: every mutation shifts indices
          for (const { edit, editIndex } of pageEdits) {
            try {
              if (edit.kind === 'insertImage') await insertImage(m, doc, page, edit, decoder)
              else if (edit.kind === 'transformImage') await transformImage(m, page, edit, guard)
              else if (edit.kind === 'replaceImage') await replaceImage(m, page, edit, guard, decoder)
              else await deleteImage(m, page, edit, guard)
              applied++
            } catch (err) {
              skipped.push({
                editIndex,
                pageIndex,
                reason: err instanceof Error ? err.message : String(err),
              })
            }
          }
          if (applied > 0 && !m._FPDFPage_GenerateContent(page)) {
            throw new Error(`could not regenerate page ${pageIndex + 1}`)
          }
          appliedTotal += applied
        } finally {
          m._FPDF_ClosePage(page)
        }
      }
      return { bytes: appliedTotal > 0 ? saveDoc(m, doc) : bytes, skipped }
    })
  })
}

/** Enumerate every page's content-stream images (rect + z-band relative to text) */
export function listPageImages(bytes: Uint8Array): Promise<PageImageRef[]> {
  return chainPdfium(async () => {
    const m = await loadPdfium()
    return withDocument(m, bytes, async (doc) => {
      const out: PageImageRef[] = []
      const pageCount = m._FPDF_GetPageCount(doc)
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        const page = m._FPDF_LoadPage(doc, pageIndex)
        if (!page) continue
        try {
          const textIdx = firstTextIndex(collectObjects(m, page))
          for (const o of collectImages(m, page)) {
            // Sub-3pt objects are decoration/artifacts; not worth an edit target
            if (o.bounds[2] - o.bounds[0] < 3 || o.bounds[3] - o.bounds[1] < 3) continue
            out.push({
              pageIndex,
              rect: o.bounds,
              aboveText: textIdx !== undefined && o.index > textIdx,
            })
          }
        } finally {
          m._FPDF_ClosePage(page)
        }
      }
      return out
    })
  })
}

/** Longest raster side (px) an upscaled render may reach; keeps bitmap memory bounded */
const RENDER_MAX_PX = 2400

/** Render one existing image object to PNG (base64) for the renderer's ghost preview.
    GetRenderedBitmap rasterizes at the object's on-page size (~1px per pt), so pixel
    edits pass scale > 1: the object matrix is enlarged before rendering (in-memory
    document only — nothing is written back) to keep the baked source sharp. */
export function renderImagePng(
  bytes: Uint8Array,
  pageIndex: number,
  rect: Rect,
  scale = 1,
  encoder?: ImageEncoder,
): Promise<string | null> {
  return chainPdfium(async () => {
    const m = await loadPdfium()
    return withDocument(m, bytes, async (doc) => {
      const page = m._FPDF_LoadPage(doc, pageIndex)
      if (!page) return null
      try {
        const target = await resolveImage(m, page, rect).catch(() => null)
        if (!target) return null
        const side = Math.max(
          target.bounds[2] - target.bounds[0],
          target.bounds[3] - target.bounds[1],
        )
        if (encoder && side > RENDER_MAX_PX) return null
        const k = Math.min(Math.max(1, scale), side > 0 ? RENDER_MAX_PX / side : 1)
        if (k > 1) m._FPDFPageObj_Transform(target.obj, k, 0, 0, k, 0, 0)
        const bmp = m._FPDFImageObj_GetRenderedBitmap(doc, page, target.obj)
        if (!bmp) return null
        try {
          const w = m._FPDFBitmap_GetWidth(bmp)
          const h = m._FPDFBitmap_GetHeight(bmp)
          const stride = m._FPDFBitmap_GetStride(bmp)
          const buf = m._FPDFBitmap_GetBuffer(bmp)
          if (!w || !h || !buf || (encoder && w * h > RENDER_MAX_PX ** 2)) return null
          const tight = Buffer.alloc(w * h * 4)
          for (let row = 0; row < h; row++) {
            tight.set(
              m.HEAPU8.subarray(buf + row * stride, buf + row * stride + w * 4),
              row * w * 4,
            )
          }
          const encodeBitmapPng = encoder ?? (await import('./image-codec')).encodeBitmapPng
          const png = encodeBitmapPng(tight, w, h)
          return png.toString('base64')
        } finally {
          m._FPDFBitmap_Destroy(bmp)
        }
      } finally {
        m._FPDF_ClosePage(page)
      }
    })
  })
}

/**
 * Live-preview render: rasterize a page region with the given image objects removed
 * (in memory only — the file is untouched). The renderer patches the region over its
 * PDF.js canvas so a moved/resized/deleted image disappears immediately instead of
 * lingering until save. Unmatched rects are skipped fail-soft.
 */
export function renderPagePreviewPng(
  bytes: Uint8Array,
  request: Omit<PagePreviewRequest, 'path'>,
  encoder?: ImageEncoder,
): Promise<PagePreviewResult | null> {
  const { pageIndex, excludeRects, excludeAnnots, excludeText, clip, pxWidth, rotate } = request
  return chainPdfium(async () => {
    const m = await loadPdfium()
    return withDocument(m, bytes, async (doc) => {
      const page = m._FPDF_LoadPage(doc, pageIndex)
      if (!page) return null
      try {
        for (const rect of excludeRects) {
          const target = await resolveImage(m, page, rect).catch(() => null)
          if (target && m._FPDFPage_RemoveObject(page, target.obj)) {
            m._FPDFPageObj_Destroy(target.obj)
          }
        }
        if (excludeAnnots && excludeAnnots.length > 0) {
          const { removeMatchingAnnots } = await import('./annot-delete')
          removeMatchingAnnots(m, page, excludeAnnots)
        }
        const textErased =
          excludeText && excludeText.length > 0
            ? await eraseTextRuns(m, doc, page, pageIndex, bytes, excludeText)
            : []
        // Page size in display orientation (pdfium already applies /Rotate; the
        // unsaved delta passed as quarter turns swaps the axes again when odd)
        const baseW = m._FPDF_GetPageWidthF(page)
        const baseH = m._FPDF_GetPageHeightF(page)
        const turns = ((rotate % 4) + 4) % 4
        const dispW = turns % 2 === 1 ? baseH : baseW
        const dispH = turns % 2 === 1 ? baseW : baseH
        if (clip.width <= 0 || clip.height <= 0 || pxWidth <= 0) return null
        const k = pxWidth / clip.width
        const w = Math.max(1, Math.round(pxWidth))
        const h = Math.max(1, Math.round(clip.height * k))
        const bufPtr = m._malloc(w * h * 4)
        const bmp = m._FPDFBitmap_CreateEx(w, h, FPDF_BITMAP_BGRA, bufPtr, w * 4)
        if (!bmp) {
          m._free(bufPtr)
          return null
        }
        try {
          m._FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff)
          // With annots excluded the clip must keep drawing the surviving annotations
          // (FPDF_ANNOT); image-only previews keep the historical annotation-free render
          const flags = excludeAnnots && excludeAnnots.length > 0 ? 1 /* FPDF_ANNOT */ : 0
          m._FPDF_RenderPageBitmap(
            bmp,
            page,
            Math.round(-clip.x * k),
            Math.round(-clip.y * k),
            Math.round(dispW * k),
            Math.round(dispH * k),
            turns,
            flags,
          )
          const tight = Buffer.from(m.HEAPU8.subarray(bufPtr, bufPtr + w * h * 4))
          const encodeBitmapPng = encoder ?? (await import('./image-codec')).encodeBitmapPng
          const png = encodeBitmapPng(tight, w, h)
          return { png: png.toString('base64'), textErased }
        } finally {
          m._FPDFBitmap_Destroy(bmp)
          m._free(bufPtr)
        }
      } finally {
        m._FPDF_ClosePage(page)
      }
    })
  })
}

/**
 * Read-back verification on the final saved bytes (pageIndex already remapped to the
 * final document): inserts and transforms must be findable at their target rect.
 * Deletes are not re-checked — RemoveObject's status is verified at apply time, and a
 * second identical image at the same bounds would read as a false failure.
 */
export function verifyImageEdits(
  bytes: Uint8Array,
  edits: { pageIndex: number; rect: Rect }[],
  /** the password when the saved output is encrypted again */
  password?: string,
): Promise<{ pageIndex: number; reason: string }[]> {
  return chainPdfium(async () => {
    const m = await loadPdfium()
    return withDocument(
      m,
      bytes,
      async (doc) => {
        const failures: { pageIndex: number; reason: string }[] = []
        const pageCount = m._FPDF_GetPageCount(doc)
        const byPage = new Map<number, Rect[]>()
        for (const e of edits) {
          if (e.pageIndex < 0 || e.pageIndex >= pageCount) {
            failures.push({ pageIndex: e.pageIndex, reason: 'page missing from saved output' })
            continue
          }
          byPage.set(e.pageIndex, [...(byPage.get(e.pageIndex) ?? []), e.rect])
        }
        for (const [pageIndex, rects] of byPage) {
          const page = m._FPDF_LoadPage(doc, pageIndex)
          if (!page) {
            for (const _ of rects)
              failures.push({ pageIndex, reason: 'page unreadable in saved output' })
            continue
          }
          try {
            const objects = collectImages(m, page)
            for (const rect of rects) {
              if (!matchImage(objects, rect)) {
                failures.push({ pageIndex, reason: 'image missing from saved output' })
              }
            }
          } finally {
            m._FPDF_ClosePage(page)
          }
        }
        return failures
      },
      password,
    )
  })
}

/** Read intrinsic pixels including the soft mask on an ephemeral document copy. */
export function readImageBitmap(bytes: Uint8Array, pageIndex: number, rect: Rect, width: number, height: number): Promise<Buffer> {
  return readImageSource(bytes, pageIndex, rect).then(source => {
    if (source.width !== width || source.height !== height) throw new Error('image pixels mismatch')
    return source.bgra
  })
}

/** Check native metadata before allocating decoded pixels; strip placement only on a copy. */
export function readImageSource(bytes: Uint8Array, pageIndex: number, rect: Rect): Promise<{width:number;height:number;bgra:Buffer}> {
  return chainPdfium(async () => {
    const m = await loadPdfium()
    return withDocument(m, bytes, async doc => {
      const page = m._FPDF_LoadPage(doc, pageIndex)
      if (!page) throw new Error('page unavailable')
      const ptr = m._malloc(24)
      try {
        const target = await resolveImage(m, page, rect)
        if (!m._FPDFImageObj_GetImagePixelSize(target.obj, ptr, ptr + 4)) throw new Error('image dimensions unavailable')
        const width = m.HEAP32[ptr >> 2]!, height = m.HEAP32[(ptr + 4) >> 2]!
        if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height * 4 > 32 * 1024 * 1024) throw new Error('image pixels limit')
        m.HEAPF32.set([width, 0, 0, height, 0, 0], ptr >> 2)
        if (!m._FPDFPageObj_SetMatrix(target.obj, ptr)) throw new Error('image matrix unavailable')
        const bitmap = m._FPDFImageObj_GetRenderedBitmap(doc, page, target.obj)
        if (!bitmap) throw new Error('image pixels unavailable')
        try {
          const actualWidth = m._FPDFBitmap_GetWidth(bitmap), actualHeight = m._FPDFBitmap_GetHeight(bitmap)
          const stride = m._FPDFBitmap_GetStride(bitmap), data = m._FPDFBitmap_GetBuffer(bitmap)
          if (actualWidth !== width || actualHeight !== height || m._FPDFBitmap_GetFormat(bitmap) !== 4 || stride < width * 4 || stride * height > 64 * 1024 * 1024 || !data) throw new Error('image pixels mismatch')
          const pixels = Buffer.alloc(width * height * 4)
          for (let row = 0; row < height; row++) pixels.set(m.HEAPU8.subarray(data + row * stride, data + row * stride + width * 4), row * width * 4)
          return {width,height,bgra:pixels}
        } finally { m._FPDFBitmap_Destroy(bitmap) }
      } finally { m._free(ptr); m._FPDF_ClosePage(page) }
    })
  })
}

/** Render only one occurrence, preserving its form ancestry, clipping and graphics state. */
export function renderImageOccurrence(bytes: Uint8Array, pageIndex: number, rect: Rect, width: number, height: number, matrix: readonly number[]): Promise<Buffer> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height * 4 > 32 * 1024 * 1024) return Promise.reject(new Error('image pixels limit'))
  return chainPdfium(async () => {
    const m = await loadPdfium()
    return withDocument(m, bytes, async doc => {
      const page = m._FPDF_LoadPage(doc, pageIndex)
      if (!page) throw new Error('page unavailable')
      const ptr = m._malloc(40), data = m._malloc(width * height * 4)
      let bitmap = 0
      try {
        const target = matchImage(collectImages(m, page), rect)
        if (!target) throw new Error('image unavailable')
        const keep = new Set([...target.chain, target.obj])
        const prune = (parent: number, form: boolean) => {
          const count = form ? m._FPDFFormObj_CountObjects(parent) : m._FPDFPage_CountObjects(parent)
          for (let index = count - 1; index >= 0; index--) {
            const object = form ? m._FPDFFormObj_GetObject(parent, index) : m._FPDFPage_GetObject(parent, index)
            if (!keep.has(object)) {
              const removed = form ? m._FPDFFormObj_RemoveObject(parent, object) : m._FPDFPage_RemoveObject(parent, object)
              if (!removed) throw new Error('image isolation failed')
              m._FPDFPageObj_Destroy(object)
            } else if (m._FPDFPageObj_GetType(object) === 5) prune(object, true)
          }
        }
        prune(page, false)
        // RenderPageBitmapWithMatrix prepends PDFium's own page display matrix
        // (CropBox + Rotate + y-flip). Cancel it before our PDF-space transform.
        const { PDFDocument } = await import('pdf-lib')
        const { pdfToView } = await import('../renderer/annotations')
        const parsed = await PDFDocument.load(bytes, { updateMetadata: false }), parsedPage = parsed.getPage(pageIndex)
        const crop = parsedPage.getCropBox(), media = parsedPage.getMediaBox()
        const x0 = Math.max(crop.x, media.x), y0 = Math.max(crop.y, media.y)
        const x1 = Math.min(crop.x + crop.width, media.x + media.width), y1 = Math.min(crop.y + crop.height, media.y + media.height)
        const geom = { pw:x1-x0, ph:y1-y0, x0, y0, rot:parsedPage.getRotation().angle, userUnit:1 }
        const o=pdfToView(geom,0,0), x=pdfToView(geom,1,0), y=pdfToView(geom,0,1)
        const [a,b,c,d,e,f]=[x[0]-o[0],x[1]-o[1],y[0]-o[0],y[1]-o[1],...o], det=a*d-b*c
        const inverse=[d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det] as const
        m.HEAPF32.set(concatMat(inverse, matrix as readonly [number,number,number,number,number,number]), ptr >> 2)
        m.HEAPF32.set([0, 0, width, height], (ptr + 24) >> 2)
        bitmap = m._FPDFBitmap_CreateEx(width, height, FPDF_BITMAP_BGRA, data, width * 4)
        if (!bitmap) throw new Error('image render allocation failed')
        m._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0)
        m._FPDF_RenderPageBitmapWithMatrix(bitmap, page, ptr, ptr + 24, 0)
        return Buffer.from(m.HEAPU8.subarray(data, data + width * height * 4))
      } finally {
        if (bitmap) m._FPDFBitmap_Destroy(bitmap)
        m._free(data); m._free(ptr); m._FPDF_ClosePage(page)
      }
    })
  })
}

export function imageOccurrenceHasClip(bytes: Uint8Array, pageIndex: number, rect: Rect): Promise<boolean> {
  return chainPdfium(async () => {
    const m = await loadPdfium()
    return withDocument(m, bytes, async doc => {
      const page = m._FPDF_LoadPage(doc, pageIndex)
      if (!page) throw new Error('page unavailable')
      try {
        const target = matchImage(collectImages(m, page), rect)
        if (!target) throw new Error('image unavailable')
        return [...target.chain, target.obj].some(object => {
          const clip = m._FPDFPageObj_GetClipPath(object)
          return !!clip && m._FPDFClipPath_CountPaths(clip) > 0
        })
      } finally { m._FPDF_ClosePage(page) }
    })
  })
}
