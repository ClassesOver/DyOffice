import fontkit from '@pdf-lib/fontkit'
import type { Subset } from '@pdf-lib/fontkit'

type TrueTypeSubset = Subset & {
  _addGlyph(glyphId: number): number
  glyf: Uint8Array[]
  offset: number
}

export const pdfFontkit = {
  create(bytes: Uint8Array, postscriptName?: string) {
    const font = fontkit.create(bytes, postscriptName)
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => {
      const subset = createSubset() as TrueTypeSubset
      if ('cff' in subset) return subset
      const addGlyph = subset._addGlyph
      // fontkit 1.1.1 chooses short loca offsets without aligning glyf records.
      // A short loca stores offset/2, so an odd record corrupts later glyphs.
      subset._addGlyph = function (glyphId) {
        const index = addGlyph.call(this, glyphId)
        const glyph = this.glyf[index]!
        if (glyph.length % 2) {
          const buffer = glyph.constructor as unknown as { alloc(length: number): Uint8Array }
          const padded = buffer.alloc(glyph.length + 1)
          padded.set(glyph)
          this.glyf[index] = padded
          this.offset += 1
        }
        return index
      }
      return subset
    }
    return font
  },
}
