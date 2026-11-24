import { geomDispSize, pdfRectToCss, pdfToView, viewToPdf } from './annotations'
import type { PageGeom } from './annotations'

interface PageDestination {
  x: number | null
  y: number
  scale: number | null
}

/** Resolve explicit PDF destinations into unscaled display coordinates and an optional zoom. */
export function pageDestination(
  dest: readonly unknown[],
  geom: PageGeom,
  viewport: { width: number; height: number },
): PageDestination | null {
  const fit = dest[1]
  const name = typeof fit === 'object' && fit !== null && 'name' in fit ? fit.name : fit
  const numberAt = (i: number): number | null => {
    const value = dest[i]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const { width, height } = geomDispSize(geom)
  const widthScale = viewport.width / width
  const heightScale = viewport.height / height
  let left: number | null = null
  let top: number | null = null
  let scale: number | null
  switch (name) {
    case 'XYZ':
      left = numberAt(2)
      top = numberAt(3)
      scale = numberAt(4)
      if (scale !== null && scale <= 0) scale = null
      if (left === null && top === null && scale === null) return null
      break
    case 'Fit':
    case 'FitB':
      return { x: 0, y: 0, scale: Math.min(widthScale, heightScale) }
    case 'FitH':
    case 'FitBH':
      top = numberAt(2)
      scale = widthScale
      break
    case 'FitV':
    case 'FitBV':
      left = numberAt(2)
      scale = heightScale
      break
    case 'FitR': {
      const x1 = numberAt(2),
        y1 = numberAt(3),
        x2 = numberAt(4),
        y2 = numberAt(5)
      if (x1 === null || y1 === null || x2 === null || y2 === null || x2 <= x1 || y2 <= y1) {
        return null
      }
      const rect = pdfRectToCss(geom, [x1, y1, x2, y2], 1)
      return {
        x: Math.max(0, Math.min(rect.left, width)),
        y: Math.max(0, Math.min(rect.top, height)),
        scale: Math.min(viewport.width / rect.width, viewport.height / rect.height),
      }
    }
    default:
      return null
  }

  // Missing coordinates start at the displayed top-left, even for rotated crop boxes.
  const [originX, originY] = viewToPdf(geom, 0, 0)
  const [x, y] = pdfToView(geom, left ?? originX, top ?? originY)
  const hasX = geom.rot % 180 === 0 ? left !== null : top !== null
  return {
    x: hasX || scale !== null ? Math.max(0, Math.min(x, width)) : null,
    y: Math.max(0, Math.min(y, height)),
    scale,
  }
}
