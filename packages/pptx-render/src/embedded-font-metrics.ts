import * as opentype from 'opentype.js'
import type { OpentypeFontLike } from './metrics'

/** Parse one embedded sfnt inside the renderer's layout process. */
export function parseEmbeddedFontMetrics(sfnt: Uint8Array): OpentypeFontLike | undefined {
  try {
    // Node exposes the CommonJS entry as default; browser builds use the named ESM export.
    const parse = opentype.parse ?? (Reflect.get(opentype, 'default') as typeof opentype | undefined)?.parse
    const font = parse?.(Uint8Array.from(sfnt).buffer, { lowMemory: true })
    if (!font) return
    if (!(font.unitsPerEm > 0) || !Number.isFinite(font.ascender) || !Number.isFinite(font.descender)) return
    return Object.assign(font, { lineGap: Number(font.tables.hhea?.lineGap) || 0 })
  } catch {
    return undefined
  }
}
