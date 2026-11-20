/**
 * Local single-page generation: a structured JSON slide spec (written by an
 * LLM through the app's own AI transport) is built directly into a one-slide
 * PPTX with pptx-engine primitives — no HTML intermediate, no conversion step.
 *
 * The spec's element model mirrors what an editable deck needs (and what
 * Genspark's gen_pptx capture emits): absolutely positioned shapes, images
 * (center-cropped to their frame) and text runs on a fixed px canvas.
 *
 * Host facilities (network fetch, image decoding, font metrics) are injected so
 * this module stays testable in plain Node and usable from the genoffice CLI.
 */
import {
  addElement,
  addPicture,
  createBlankPptx,
  editPictureSrcRect,
  openPptx,
  promoteSlideBackground,
  savePptx,
  type Paragraph,
  type TextElement,
  type TextRun,
} from '@genoffice/pptx-engine'
import { buildRenderSlide, EMU_PER_PX_96, type FontMetricsProvider } from '@genoffice/pptx-render'
import { coverCropFractions } from './cover-crop'

import { SPEC_CANVAS_W, type PageSpec, type SpecImage, type SpecParagraph } from './page-spec-parser'
export * from './page-spec-parser'

const EMU_PER_PT = 12700

export interface BuildPageDeps {
  /** Downloads an image; null on failure (page continues without it) */
  fetchImage: (url: string) => Promise<{ bytes: Uint8Array; ext: string } | null>
  /** Decodes natural pixel size for cover-cropping; null skips the crop */
  imageDims?: (bytes: Uint8Array) => { width: number; height: number } | null
  /** Font metrics for the post-build text measurement; absent skips the box-height fix */
  fontMetrics?: FontMetricsProvider
}

/**
 * The LLM sizes text boxes from a rough chars-per-line heuristic, which routinely
 * undersizes big CJK titles; the box has no autofit, so the canvas draws the overflow
 * past the selection frame (and PowerPoint past the shape). Re-measure every text box
 * with the real layout engine — on the reopened (parsed) model, the exact input the
 * landed page will render from — and grow too-short boxes to their content height.
 * Grow-only, plain text boxes only (shape label boxes are design intent); middle/bottom
 * anchored boxes shift up so the rendered glyphs stay exactly where they were.
 * Returns the re-saved bytes, or null when every box already fits.
 */
async function growTextBoxesToContent(
  bytes: Uint8Array,
  metrics: FontMetricsProvider,
): Promise<Uint8Array | null> {
  const opened = await openPptx(bytes)
  const slide = opened.deck.slides[0]
  if (!slide) return null
  const baseWidthPx = opened.deck.size.cx / EMU_PER_PX_96 // native px → vp.scale = 1
  const rendered = buildRenderSlide(slide, opened.deck.size, { fitWidthPx: baseWidthPx, metrics })
  let changed = false
  for (const node of rendered.nodes) {
    if (node.type !== 'text' || !node.text) continue
    const el = slide.elements.find((e) => e.id === node.sourceId)
    if (el?.type !== 'text') continue
    const t = node.text
    const needH = Math.max(t.contentHeight, t.inkBottom ?? 0) + t.insets.t + t.insets.b
    const growPx = needH - node.box.h
    if (growPx < 0.5) continue
    const tel = el as TextElement
    const offset = { ...tel.transform.offset, cy: Math.max(1, Math.round(needH * EMU_PER_PX_96)) }
    if (t.anchor === 'middle') offset.y -= Math.round((growPx / 2) * EMU_PER_PX_96)
    else if (t.anchor === 'bottom') offset.y -= Math.round(growPx * EMU_PER_PX_96)
    tel.transform = { ...tel.transform, offset }
    tel.dirtyTransform = true
    changed = true
  }
  return changed ? savePptx(opened) : null
}

function toEngineParagraphs(paragraphs: SpecParagraph[]): Paragraph[] {
  return paragraphs.map((p) => {
    const runs: TextRun[] = p.runs.map((r) => ({
      text: r.text,
      ...(r.sizePt ? { fontSize: r.sizePt } : {}),
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italic: true } : {}),
      ...(r.color ? { color: r.color } : {}),
      ...(r.font ? { fontFamily: r.font, latinFont: r.font, eaFont: r.font } : {}),
    }))
    return {
      runs,
      ...(p.align ? { align: p.align } : {}),
      ...(p.lineSpacingPct ? { lineHeight: p.lineSpacingPct } : {}),
      ...(p.spaceBeforePt !== undefined ? { spaceBefore: p.spaceBeforePt } : {}),
      ...(p.spaceAfterPt !== undefined ? { spaceAfter: p.spaceAfterPt } : {}),
      ...(p.bullet
        ? { bullet: { type: 'char' as const, char: '•' }, marL: 228600, indent: -228600 }
        : {}),
    }
  })
}

/**
 * Builds a one-slide PPTX from the spec. Elements are added in array order
 * (spec order = z-order); a background color becomes a full-bleed rect that
 * the landing pipeline's promoteSlideBackground lifts to the slide background.
 */
export async function buildPagePptx(
  spec: PageSpec,
  deps: BuildPageDeps,
  canvasW = SPEC_CANVAS_W,
): Promise<{ bytes: Uint8Array; imageFailures: string[]; imageWarnings: string[]; size: {cx: number; cy: number} }> {
  const opened = await openPptx(await createBlankPptx())
  const slide = opened.deck.slides[0]!
  const scale = opened.deck.size.cx / canvasW
  const toEmu = (px: number) => Math.round(px * scale)
  const anchorOf = (
    v: 'top' | 'middle' | 'bottom' | undefined,
    dflt: 't' | 'ctr',
  ): 't' | 'ctr' | 'b' => (v === 'top' ? 't' : v === 'middle' ? 'ctr' : v === 'bottom' ? 'b' : dflt)
  // Zero insets: the spec's boxes are exact; PowerPoint's default 0.1in/0.05in
  // insets would shift every text off its planned spot.
  const zeroInsets = { l: 0, t: 0, r: 0, b: 0 }

  const imageFailures: string[] = []
  const imageWarnings: string[] = []
  const fetched = new Map<string, { bytes: Uint8Array; ext: string } | null>()
  await Promise.all(
    [
      ...new Set(spec.elements.filter((e) => e.type === 'image').map((e) => (e as SpecImage).url)),
    ].map(async (url) => {
      try {
        fetched.set(url, await deps.fetchImage(url))
      } catch {
        fetched.set(url, null)
      }
    }),
  )

  if (spec.background) {
    addElement(slide, {
      kind: 'rect',
      offset: { x: 0, y: 0, cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      fillColor: spec.background,
    })
  }

  for (const el of spec.elements) {
    const offset = {
      x: toEmu(el.x),
      y: toEmu(el.y),
      cx: Math.max(1, toEmu(el.w)),
      cy: Math.max(1, toEmu(el.h)),
    }
    if (el.type === 'image') {
      const img = fetched.get(el.url)
      if (!img) {
        imageFailures.push(el.url)
        continue
      }
      const pic = addPicture(opened, slide, { bytes: img.bytes, ext: img.ext, offset })
      if (!pic) {
        imageFailures.push(el.url)
        continue
      }
      const dims = deps.imageDims?.(img.bytes) ?? null
      if (dims) {
        const crop = coverCropFractions(dims.width, dims.height, el.w, el.h)
        if (crop) {
          editPictureSrcRect(slide, pic.id, crop)
          const warning = heavyCropWarning(el, dims, crop)
          if (warning) imageWarnings.push(warning)
        }
      }
      continue
    }
    if (el.type === 'text') {
      addElement(slide, {
        kind: 'textbox',
        offset,
        paragraphs: toEngineParagraphs(el.paragraphs),
        bodyPr: { wrap: 'square', anchor: anchorOf(el.valign, 't'), insetsEmu: zeroInsets },
      })
      continue
    }
    addElement(slide, {
      kind: el.shape,
      offset,
      ...(el.fill ? { fillColor: el.fill } : {}),
      ...(el.stroke
        ? {
            stroke: {
              color: el.stroke.color,
              widthEmu: Math.round(el.stroke.widthPt * EMU_PER_PT),
            },
          }
        : {}),
      ...(el.flipH ? { flipH: true } : {}),
      ...(el.flipV ? { flipV: true } : {}),
      ...(el.paragraphs ? { paragraphs: toEngineParagraphs(el.paragraphs) } : {}),
      ...(el.paragraphs
        ? { bodyPr: { wrap: 'square', anchor: anchorOf(el.valign, 'ctr'), insetsEmu: zeroInsets } }
        : {}),
    })
  }

  promoteSlideBackground(slide, opened.deck.size)
  let bytes = await savePptx(opened)
  if (deps.fontMetrics) bytes = (await growTextBoxesToContent(bytes, deps.fontMetrics)) ?? bytes
  return { bytes, imageFailures, imageWarnings, size: { ...opened.deck.size } }
}

/** Below this share of the source left visible, the center crop is reported (a square photo in a 16:9 banner keeps 56% and passes). */
export const HEAVY_CROP_KEEP = 0.5

/**
 * A box whose aspect is far from the picture's throws most of the picture
 * away: a 1200×1500 product shot in a 314×96 strip shows a quarter of it, cut
 * through the middle. The build still lands it (cover-crop never distorts),
 * but the author should hear about it.
 */
function heavyCropWarning(
  el: SpecImage,
  dims: { width: number; height: number },
  crop: { l: number; t: number; r: number; b: number },
): string | null {
  const kept = (1 - crop.l - crop.r) * (1 - crop.t - crop.b)
  if (kept >= HEAVY_CROP_KEEP) return null
  const axis = crop.t > 0 ? 'top and bottom' : 'left and right'
  return `image ${el.url}: the ${Math.round(el.w)}×${Math.round(el.h)} box shows only ${Math.round(kept * 100)}% of the ${dims.width}×${dims.height} picture (center crop, ${axis} cut off); size the box nearer the picture's aspect ratio or crop the file first`
}
