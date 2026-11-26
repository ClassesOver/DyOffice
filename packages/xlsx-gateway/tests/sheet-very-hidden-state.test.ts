import { describe, expect, it } from 'vitest'

import { applySheetPlanToWorkbookXml, parseSheetElements } from '../src/gateway/xlsx-sheets'

const WORKBOOK =
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<bookViews><workbookView activeTab="2"/></bookViews>' +
  '<sheets>' +
  '<sheet name="A" sheetId="1" r:id="rId1"/>' +
  '<sheet name="B" sheetId="2" state="hidden" r:id="rId2"/>' +
  '<sheet name="C" sheetId="3" state="veryHidden" r:id="rId3"/>' +
  '</sheets></workbook>'

const plan = (hiddenChanges: { sheetName: string; hidden: boolean }[]) => ({
  renames: [],
  additions: [],
  removals: [],
  order: ['A', 'B', 'C'],
  hiddenChanges,
})

describe('veryHidden sheet state', () => {
  it('updates real sheet attributes and preserves the sheet-list wrapper and comments', () => {
    const comment = '<!-- <sheets><sheet name="Fake"/></sheets> -->'
    const xml = WORKBOOK.replace('<sheets>', '<sheets xmlns:ext="urn:example">' + comment)
      .replace('name="B" sheetId="2" state="hidden"', "ext:name='extension' name = 'B' sheetId='2' state = 'hidden'")
      .replace('</sheets></workbook>', '</sheets ></workbook>')
    const result = applySheetPlanToWorkbookXml(xml, {
      ...plan([{ sheetName: 'B', hidden: false }]),
      renames: [{ sheetName: 'B', newName: 'Renamed' }],
      order: ['Renamed', 'A', 'C'],
    }, [])
    expect(result).toContain('<sheets xmlns:ext="urn:example">' + comment)
    expect(result).toContain('</sheets >')
    expect(result).toContain("ext:name='extension'")
    expect(parseSheetElements(result).map(({ name, hidden }) => [name, hidden])).toEqual([
      ['Renamed', false], ['A', false], ['C', true],
    ])
  })

  it('parses the tri-state', () => {
    expect(parseSheetElements(WORKBOOK).map((e) => [e.hidden, e.veryHidden])).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ])
  })

  it('keeps veryHidden sheets hidden and moves the active tab to the first visible sheet', () => {
    const result = applySheetPlanToWorkbookXml(
      WORKBOOK,
      plan([{ sheetName: 'B', hidden: false }]),
      [],
    )
    expect(result).toContain('<sheet name="B" sheetId="2" r:id="rId2"/>')
    expect(result).toContain('<sheet name="C" sheetId="3" state="veryHidden" r:id="rId3"/>')
    expect(result).toContain('activeTab="0"')
  })

  it('is not downgraded by a redundant hide of the sheet itself', () => {
    const result = applySheetPlanToWorkbookXml(
      WORKBOOK,
      plan([{ sheetName: 'C', hidden: true }]),
      [],
    )
    expect(result).toContain('<sheet name="C" sheetId="3" state="veryHidden" r:id="rId3"/>')
  })

  it('clears the state only on an explicit unhide', () => {
    const result = applySheetPlanToWorkbookXml(
      WORKBOOK,
      plan([{ sheetName: 'C', hidden: false }]),
      [],
    )
    expect(result).toContain('<sheet name="C" sheetId="3" r:id="rId3"/>')
  })
})
