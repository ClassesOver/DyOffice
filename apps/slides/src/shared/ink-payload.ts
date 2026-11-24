export type InkPenKind = 'pen' | 'highlighter' | 'pencil'
export type InkTool = 'select' | InkPenKind | 'eraser'

export const isPenKind = (tool: InkTool): tool is InkPenKind =>
  tool === 'pen' || tool === 'highlighter' || tool === 'pencil'

export interface InkPoint {
  x: number
  y: number
}

export interface InkStroke {
  tool: InkPenKind
  /** hex without '#' */
  color: string
  /** Stroke width in px (fitWidth viewport at 100% zoom) */
  width: number
  /** Page px coordinates (converted to be relative to the bounding box top-left before committing) */
  points: InkPoint[]
}

export const MAX_INK_PAYLOAD_BYTES = 480_000

export const INK_NAME_PREFIX = 'aislides-ink'

// ---- payload (cNvPr descr) round-trip ----

const PAYLOAD_VERSION = 1

/** points must already be relative to the bounding box top-left */
export function encodeInkPayload(stroke: InkStroke): string {
  return JSON.stringify({
    v: PAYLOAD_VERSION,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
    // Round to 0.1px: keep the descr attribute size manageable even for long strokes
    points: stroke.points.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
  })
}

/** descr payloads are file-controlled: cap points, reject non-finite coords. */
const MAX_INK_POINTS = 20_000
const MAX_INK_WIDTH = 200

export function decodeInkPayload(payload: string): InkStroke | null {
  try {
    const data = JSON.parse(payload) as {
      v?: number
      tool?: string
      color?: string
      width?: number
      points?: [number, number][]
    }
    if (data.v !== PAYLOAD_VERSION || !Array.isArray(data.points) || data.points.length === 0) {
      return null
    }
    if (data.points.length > MAX_INK_POINTS) return null
    const points: InkPoint[] = []
    for (const pair of data.points) {
      if (!Array.isArray(pair) || pair.length !== 2) return null
      const [x, y] = pair
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        return null
      }
      points.push({ x, y })
    }
    return {
      tool: data.tool === 'highlighter' || data.tool === 'pencil' ? data.tool : 'pen',
      color:
        typeof data.color === 'string' && /^[0-9a-fA-F]{6}$/.test(data.color)
          ? data.color
          : '000000',
      width:
        typeof data.width === 'number' && Number.isFinite(data.width) && data.width > 0
          ? Math.min(data.width, MAX_INK_WIDTH)
          : 2,
      points,
    }
  } catch {
    return null
  }
}
