import { describe, expect, it } from 'vitest'

import {
  applySparklineAdditions,
  sparklineEntries,
  sparklineTarget,
  SPARKLINE_EXT_URI,
  worksheetSparklineGroups,
} from '../src/gateway/xlsx-sparkline'
import {
  scopedChildren,
  worksheetRoot,
  X14_XMLNS,
  XM_XMLNS,
} from '../src/gateway/xlsx-worksheet-xml'

const sheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const addition = (cell: string) => [
  { type: 'line' as const, cells: [{ cell, sourceRef: 'Data!A1:A3' }] },
]
const existing =
  '<v:sparklineGroups><v:sparklineGroup><v:sparklines><v:sparkline>' +
  '<m:f>Data!A1:A3</m:f><m:sqref> $D$2 </m:sqref></v:sparkline></v:sparklines></v:sparklineGroup></v:sparklineGroups>'
const ext = `<s:ext uri='${SPARKLINE_EXT_URI}' xmlns:v="${X14_XMLNS}" xmlns:m="${XM_XMLNS}">${existing}</s:ext>`
const unrelated = `<s:ext uri="urn:other" xmlns:xm="${XM_XMLNS}"><xm:sqref>E2</xm:sqref></s:ext>`
const workbook = (content: string) =>
  `<s:worksheet xmlns:s="${sheetNamespace}">${content}</s:worksheet>`

describe('worksheet sparkline additions', () => {
  it('appends to an aliased group collection without treating other extension targets as occupied', () => {
    const xml = workbook(`<s:sheetData/><s:extLst>${unrelated}${ext}</s:extLst>`)
    const saved = applySparklineAdditions(xml, addition('E2'))
    expect(saved).toContain(unrelated)
    expect(saved).toContain(existing.slice(0, existing.lastIndexOf('</v:sparklineGroups>')))
    expect(saved).toMatch(/<xm:sqref>E2<\/xm:sqref><\/x14:sparkline>.*<\/v:sparklineGroups>/)
    expect(saved.match(/uri=['"]\{05C60535-/gi)).toHaveLength(1)
    const groups = worksheetSparklineGroups(scopedChildren(worksheetRoot(saved)!))
    expect(
      groups.flatMap(sparklineEntries).map((entry) => sparklineTarget(scopedChildren(entry))),
    ).toEqual(['D2', 'E2'])
  })

  it('rejects duplicates for canonical addresses even with aliased and absolute targets', () => {
    const xml = workbook(`<s:sheetData/><s:extLst>${ext}</s:extLst>`)
    expect(() => applySparklineAdditions(xml, addition('D2'))).toThrow('D2 already has a sparkline')
    expect(() =>
      applySparklineAdditions(workbook('<s:sheetData/>'), [...addition('D2'), ...addition('$D$2')]),
    ).toThrow('D2 already has a sparkline')
  })

  it('fills a self-closing worksheet extension while preserving nested namesakes', () => {
    const nested = `<s:extLst>${ext}</s:extLst>`
    const sheetData = `<s:sheetData><s:row r="2"><s:c r="D2">${nested}</s:c></s:row></s:sheetData>`
    const xml = workbook(`${sheetData}<s:extLst><s:ext uri="${SPARKLINE_EXT_URI}"/></s:extLst>`)
    const saved = applySparklineAdditions(xml, addition('D2'))
    expect(saved).toContain(sheetData)
    expect(saved).toMatch(/<\/s:sheetData><s:extLst><s:ext uri="[^"<>]+"><x14:sparklineGroups/)
    expect(saved.match(/uri=['"]\{05C60535-/gi)).toHaveLength(2)
  })
})
