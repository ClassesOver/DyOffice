import type { RenderNode } from '@genoffice/pptx-render'
import { parseParaStateKey, type NodeAnimState } from './animation-play'

type ParagraphState = { para: number; st: NodeAnimState }

type ClipRect = { x: number; y: number; w: number; h: number }

type NodeAnimationLayer = {
  key: number | 'base'
  transform?: ReturnType<typeof stateGroupProps>
  clips?: ClipRect[]
}

export function groupParagraphStates(states: ReadonlyMap<string, NodeAnimState>) {
  const bySource = new Map<string, ParagraphState[]>()
  for (const [key, st] of states) {
    const id = parseParaStateKey(key)
    if (!id) continue
    const list = bySource.get(id.sourceId) ?? []
    list.push({ para: id.para, st })
    bySource.set(id.sourceId, list)
  }
  return bySource
}

function stateGroupProps(st: NodeAnimState, cx: number, cy: number) {
  return {
    x: cx + st.dx,
    y: cy + st.dy,
    offsetX: cx,
    offsetY: cy,
    scaleX: st.scale * st.scaleX,
    scaleY: st.scale,
    rotation: st.rotationDeg,
    opacity: st.opacity,
  }
}

/** Wipe/split clip narrows the visible area to a portion of the original height. */
function wipedRect(clip: NonNullable<NodeAnimState['clip']>, y: number, h: number) {
  const visH = h * clip.t
  if (clip.mode === 'top') return { y, h: visH }
  if (clip.mode === 'mid') return { y: y + (h - visH) / 2, h: visH }
  return { y: y + (h - visH), h: visH }
}

function paragraphSpans(node: RenderNode): Array<{ y0: number; y1: number }> {
  const text = node.type === 'shape' || node.type === 'text' ? node.text : undefined
  if (!text) return []
  const base = node.box.y + text.insets.t
  const spans: Array<{ y0: number; y1: number }> = []
  for (const line of text.lines) {
    const y0 = base + line.top
    const y1 = y0 + line.height
    if (line.paraStart === false && spans.length) {
      const last = spans[spans.length - 1]!
      last.y1 = Math.max(last.y1, y1)
    } else {
      spans.push({ y0, y1 })
    }
  }
  return spans
}

/** Placement and clipping of the copies drawn by the animated stage, in paint order. */
export function animatedNodeLayout(
  node: RenderNode,
  st?: NodeAnimState,
  paragraphs?: ParagraphState[],
): { transform?: ReturnType<typeof stateGroupProps>; layers: NodeAnimationLayer[] } {
  if (st?.hidden) return { layers: [] }
  const b = node.box
  const cx = b.x + b.w / 2
  const transform = st && stateGroupProps(st, cx, b.y + b.h / 2)
  const spans = paragraphs?.length ? paragraphSpans(node) : []
  // Paragraph indexes may go out of range after text edits.
  const active = (paragraphs ?? []).filter((p) => spans[p.para]).sort((x, y) => x.para - y.para)
  const margin = Math.max(20, b.h * 0.1) // Leave room for strokes and shadows.
  const horizontalClip = { x: b.x - margin, w: b.w + 2 * margin }
  if (!active.length) {
    const clip = st?.clip
    if (!clip) return { transform, layers: [{ key: 'base' }] }
    const rect = wipedRect(clip, b.y, b.h)
    const top = clip.mode === 'top' ? margin : 0
    const bottom = clip.mode === 'btm' ? margin : 0
    const clips = [{ ...horizontalClip, y: rect.y - top, h: rect.h + top + bottom }]
    return { transform, layers: [{ key: 'base', clips }] }
  }

  // The base omits animated line strips. Each visible paragraph draws one clipped copy
  // with its own animation around the strip center, inside the whole-node animation.
  const base: ClipRect[] = []
  let y = b.y - margin
  for (const { para } of active) {
    const { y0, y1 } = spans[para]!
    if (y0 > y) base.push({ ...horizontalClip, y, h: y0 - y })
    y = Math.max(y, y1)
  }
  const end = b.y + b.h + margin
  if (end > y) base.push({ ...horizontalClip, y, h: end - y })
  const layers: NodeAnimationLayer[] = [{ key: 'base', clips: base }]
  for (const { para, st } of active) {
    if (st.hidden) continue
    const { y0, y1 } = spans[para]!
    const clip = st.clip ? wipedRect(st.clip, y0, y1 - y0) : { y: y0, h: y1 - y0 }
    layers.push({
      key: para,
      transform: stateGroupProps(st, cx, (y0 + y1) / 2),
      clips: [{ ...horizontalClip, ...clip }],
    })
  }
  return { transform, layers }
}
