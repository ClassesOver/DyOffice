import { describe, expect, it } from 'vitest'
import {
  isGridCellAddress,
  MAX_GRID_COLUMNS,
  MAX_GRID_ROWS,
  parseSharedStringsXml,
} from '../src/gateway/xlsx-gateway'

describe('workbook open bounds', () => {
  it('accepts grid-edge addresses and rejects out-of-grid ones', () => {
    expect(MAX_GRID_ROWS).toBe(1_048_576)
    expect(MAX_GRID_COLUMNS).toBe(16_384)
    expect(isGridCellAddress('A1')).toBe(true)
    expect(isGridCellAddress('XFD1048576')).toBe(true)
    expect(isGridCellAddress('XFE1')).toBe(false)
    expect(isGridCellAddress('A1048577')).toBe(false)
    expect(isGridCellAddress('A0')).toBe(false)
    expect(isGridCellAddress('a1')).toBe(false)
    expect(isGridCellAddress('')).toBe(false)
  })

  it('parses shared strings', () => {
    const xml =
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">` +
      `<si><t>hello</t></si><si><t>a</t><t>b</t></si></sst>`
    expect(parseSharedStringsXml(xml)).toEqual(['hello', 'ab'])
    expect(parseSharedStringsXml('<sst/>')).toEqual([])
  })

  it('uses each text node’s XML whitespace policy before decoding spreadsheet escapes', () => {
    const xml = `<sst><si><t> &#9;label&#10; </t></si><si><t xml:space='preserve'>  padded  </t></si>
      <si><r><t> First </t></r><r><t xml:space="preserve"> Second </t></r></si>
      <si><t> _x0020_fixed_x0020_ </t></si><si><t>&#160;nonbreaking&#160;</t></si></sst>`
    expect(parseSharedStringsXml(xml)).toEqual(['label', '  padded  ', 'First Second ', ' fixed ', '\u00a0nonbreaking\u00a0'])
  })

  it('reads literal CDATA and skips comments in plain and rich shared strings', () => {
    const xml = '<sst><si><t> Start &amp; <!-- <t>ignored</t> -->' +
      '<![CDATA[&amp; </t> </si>]]> End </t></si><si><r><t><![CDATA[</r>]]></t></r>' +
      '<rPh sb="0" eb="1"><t>ignored</t></rPh><r><t>Text</t></r></si></sst>'
    expect(parseSharedStringsXml(xml)).toEqual(['Start & &amp; </t> </si> End', '</r>Text'])
  })
})
