import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { findFontCovering } from '../src/font-locate'
import * as sfnt from '../src/sfnt'
import { buildNameTable, buildSfnt } from './helpers/synthetic-font'

/** Table tags of a standalone sfnt buffer */
function tableTags(font: Buffer): string[] {
  const n = font.readUInt16BE(4)
  const tags: string[] = []
  for (let i = 0; i < n; i++) tags.push(font.toString('latin1', 12 + i * 16, 16 + i * 16))
  return tags
}

describe('findFontCovering', () => {
  it('returns null for empty text', () => {
    expect(findFontCovering('')).toBeNull()
    expect(findFontCovering('\n')).toBeNull()
  })

  it('finds an installed face covering plain Latin', () => {
    const bytes = findFontCovering('Hello world')
    if (bytes === null && process.platform === 'linux') return // fontless CI container
    expect(bytes).not.toBeNull()
    expect(tableTags(bytes!).some((t) => t === 'glyf' || t === 'CFF ')).toBe(true)
  })

  it('returns null when none of the available faces maps the requested codepoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'font-covering-'))
    const cmap = Buffer.alloc(40)
    cmap.writeUInt16BE(1, 2) // One Windows Unicode subtable at offset 12.
    cmap.writeUInt16BE(3, 4)
    cmap.writeUInt16BE(10, 6)
    cmap.writeUInt32BE(12, 8)
    cmap.writeUInt16BE(12, 12) // Format 12 with one group mapping U+0041 to glyph 1.
    cmap.writeUInt32BE(28, 16)
    cmap.writeUInt32BE(1, 24)
    cmap.writeUInt32BE(0x41, 28)
    cmap.writeUInt32BE(0x41, 32)
    cmap.writeUInt32BE(1, 36)

    const index = { byPs: new Map(), byFamily: new Map() }
    const getFontIndex = vi.spyOn(sfnt, 'getFontIndex').mockReturnValue(index)
    try {
      const name = buildNameTable([{ platform: 3, encoding: 1, language: 0x0409, nameId: 1, text: 'Coverage fixture' }])
      const font = buildSfnt([['name', name], ['cmap', cmap], ['glyf', Buffer.alloc(1)]])
      writeFileSync(join(dir, 'coverage.ttf'), font)
      sfnt.indexFontDirectory(dir, index)
      expect(findFontCovering('A')).toEqual(font)
      expect(findFontCovering('AB')).toBeNull()
    } finally {
      getFontIndex.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never picks a color-emoji face', () => {
    const bytes = findFontCovering('🦄')
    if (bytes === null) return // expected on most machines: only color fonts map emoji
    const tags = tableTags(bytes)
    for (const color of ['sbix', 'COLR', 'CBDT', 'CBLC']) expect(tags).not.toContain(color)
  })
})
