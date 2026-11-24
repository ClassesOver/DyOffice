import type { RenderNode } from '@genoffice/pptx-render'
import type { LinkTargetOp } from '../shared/ipc'
import { animatedNodeLayout, groupParagraphStates } from './animated-node-layout'
import type { NodeAnimState } from './animation-play'
import { boxPivotProps } from './konva-adapter'

type Point = { x: number; y: number }

/** Undo the same translate, rotate, scale and offset sequence as a Konva group. */
function localPoint(p: Point, placement: ReturnType<typeof boxPivotProps>): Point {
  const dx = p.x - placement.x
  const dy = p.y - placement.y
  const rad = (placement.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: (dx * cos + dy * sin) / placement.scaleX + placement.offsetX,
    y: (dy * cos - dx * sin) / placement.scaleY + placement.offsetY,
  }
}

function inRect(p: Point, { x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h
}

/** Topmost rendered link at a point in slide-model pixels. */
export function hitShowLink(
  nodes: readonly RenderNode[],
  point: Point,
  links: ReadonlyMap<string, LinkTargetOp>,
  runLinks: ReadonlyMap<string, LinkTargetOp>,
  states: ReadonlyMap<string, NodeAnimState>,
): LinkTargetOp | null {
  // StaticNode descendants use group-local coordinates and only slide roots have
  // animation wrappers. Unlinked overlaps allow a click to pass through.
  function hitNode(
    node: RenderNode,
    p: Point,
    inheritedFlipH: boolean,
    inheritedFlipV: boolean,
  ): LinkTargetOp | undefined {
    const { box } = node
    const local = localPoint(p, boxPivotProps(box))
    const flipH = !!box.flipH !== inheritedFlipH
    const flipV = !!box.flipV !== inheritedFlipV
    if (node.type === 'group') {
      // A group doesn't clip its children, including children that rotate outside it.
      for (let i = node.children.length - 1; i >= 0; i--) {
        const target = hitNode(node.children[i]!, local, flipH, flipV)
        if (target) return target
      }
    }
    if (!inRect(local, { x: 0, y: 0, w: box.w, h: box.h })) return

    // NodeBody applies one counter-flip to text using the parity of all ancestor flips.
    const text = node.type === 'shape' || node.type === 'text' ? node.text : undefined
    if (text && runLinks.size) {
      const x = (flipH ? box.w - local.x : local.x) - text.insets.l
      const y = (flipV ? box.h - local.y : local.y) - text.insets.t
      let para = -1
      for (const line of text.lines) {
        if (line.paraStart !== false) para++
        if (y < line.top || y > line.top + line.height) continue
        for (const run of line.runs) {
          if (run.srcRunIdx == null || x < run.x || x > run.x + run.widthPx) continue
          const target = runLinks.get(`${node.sourceId}:${para}:${run.srcRunIdx}`)
          if (target) return target
        }
      }
    }
    return links.get(node.sourceId)
  }

  const paragraphs = groupParagraphStates(states)
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    if (node.decoration) continue
    const st = states.get(node.sourceId)
    const para = paragraphs.get(node.sourceId)
    if (!st && !para) {
      const target = hitNode(node, point, false, false)
      if (target) return target
      continue
    }

    const { transform, layers } = animatedNodeLayout(node, st, para)
    if (transform && (!transform.opacity || !transform.scaleX || !transform.scaleY)) continue
    const animated = transform ? localPoint(point, transform) : point
    for (let j = layers.length - 1; j >= 0; j--) {
      const { transform: placement, clips } = layers[j]!
      if (placement && (!placement.opacity || !placement.scaleX || !placement.scaleY)) continue
      const p = placement ? localPoint(animated, placement) : animated
      if (clips && !clips.some((clip) => clip.h > 0 && inRect(p, clip))) continue
      const target = hitNode(node, p, false, false)
      if (target) return target
    }
  }
  return null
}
