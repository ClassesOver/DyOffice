import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import fontkit from '@pdf-lib/fontkit'
import { pdfFontkit } from '../../src/editors/pdf-fontkit.ts'

function encodeSubset(subset) {
  return new Promise((resolve, reject) => {
    const chunks = []
    subset.encodeStream().on('data', bytes => chunks.push(bytes)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject)
  })
}

test('PDF TrueType subsets preserve every Chinese and Latin glyph outline after odd-length glyphs', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../docs/src/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2', import.meta.url)))
  const original = fontkit.create(bytes)
  const font = pdfFontkit.create(bytes)
  const subset = font.createSubset()
  const glyphs = Array.from('结构报告第一项第二项名称数量苹果3季度报告经营结果收入增长 12%。ABCxyz').map(character => {
    const glyph = original.glyphForCodePoint(character.codePointAt(0))
    return { glyph, id: subset.includeGlyph(font.glyphForCodePoint(character.codePointAt(0))) }
  })
  const reopened = fontkit.create(await encodeSubset(subset))
  for (const {glyph, id} of glyphs) {
    assert.equal(reopened.getGlyph(id).path.toSVG(), glyph.path.toSVG(), `glyph ${glyph.codePoints}`)
  }
})

test('PDF adapter leaves CFF font subsetting unchanged', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../../node_modules/katex/src/fonts/lib/Extra.otf', import.meta.url)))
  const original = fontkit.create(bytes)
  const adapted = pdfFontkit.create(bytes)
  const expected = original.createSubset()
  const actual = adapted.createSubset()
  assert.ok(expected.cff)
  for (const point of original.characterSet.slice(0, 8)) {
    expected.includeGlyph(original.glyphForCodePoint(point))
    actual.includeGlyph(adapted.glyphForCodePoint(point))
  }
  assert.deepEqual(await encodeSubset(actual), await encodeSubset(expected))
})

test('PDF adapter preserves compound glyphs from a regular TrueType font', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../docs/src/renderer/fonts/LiberationSans-Regular.ttf', import.meta.url)))
  const font = pdfFontkit.create(bytes)
  const subset = font.createSubset()
  const glyphs = Array.from('ÀÉÇñＡabc').filter(character => font.hasGlyphForCodePoint(character.codePointAt(0))).map(character => {
    const glyph = font.glyphForCodePoint(character.codePointAt(0))
    return { glyph, id: subset.includeGlyph(glyph) }
  })
  const reopened = fontkit.create(await encodeSubset(subset))
  for (const {glyph, id} of glyphs) assert.equal(reopened.getGlyph(id).path.toSVG(), glyph.path.toSVG())
})
