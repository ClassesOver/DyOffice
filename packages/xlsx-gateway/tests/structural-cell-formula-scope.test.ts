import { describe, expect, it } from 'vitest'

import { renameSheetReferencesInWorksheet } from '../src/gateway/xlsx-sheets'
import { applyStructuralOps, shiftCrossSheetFormulas } from '../src/gateway/xlsx-structure'

const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const embedded = '<extLst><ext uri="urn:foreign"><f xmlns="urn:foreign">Data!A2</f></ext></extLst>'
const foreign = '<outside xmlns="urn:foreign"><f>Data!A2</f></outside>'
const worksheet =
  `<worksheet xmlns="${namespace}" xmlns:s="${namespace}"><sheetData>` +
  '<row r="2"><c r="C2"><s:f><![CDATA[Data!A2+A2]]></s:f>' +
  embedded +
  '</c></row></sheetData>' +
  foreign +
  '</worksheet>'

describe('worksheet cell formula scope', () => {
  it('moves aliased cell formulas with rows and columns and preserves extension formulas', () => {
    const moved = applyStructuralOps(
      worksheet,
      [
        { kind: 'insert-rows', index: 0, count: 1 },
        { kind: 'insert-cols', index: 0, count: 1 },
      ],
      'Data',
    )
    expect(moved).toContain('<c r="D3"><s:f>Data!B3+B3</s:f>')
    expect(moved).toContain(embedded)
    expect(moved).toContain(foreign)
  })

  it('shifts cross-sheet references and renames only genuine cell formulas', () => {
    const shifted = shiftCrossSheetFormulas(worksheet, 'Data', [
      { kind: 'insert-rows', index: 0, count: 1 },
    ])
    const renamed = renameSheetReferencesInWorksheet(shifted, 'Data', 'New Tab')
    expect(renamed).toContain(`<c r="C2"><s:f>'New Tab'!A3+A2</s:f>`)
    expect(renamed).toContain(embedded)
    expect(renamed).toContain(foreign)
  })

  it('materializes a surviving aliased shared follower using its worksheet anchor', () => {
    const fakeAnchor = '<f xmlns="urn:foreign" t="shared" ref="D2:D3" si="1">Z2</f>'
    const xml =
      `<worksheet xmlns="${namespace}" xmlns:s="${namespace}"><sheetData>` +
      '<row r="2"><c r="D2"><s:f t="shared" ref="D2:D3" si="1">B2</s:f>' +
      fakeAnchor +
      '</c></row>' +
      '<row r="3"><c r="D3"><s:f t="shared" si="1"/></c></row></sheetData></worksheet>'
    const shifted = applyStructuralOps(xml, [{ kind: 'remove-rows', index: 1, count: 1 }], 'Data')
    expect(shifted).toContain('<c r="D2"><s:f>B2</s:f></c>')
  })

  it('moves fully qualified grid addresses and column definitions without touching namesakes', () => {
    const foreignCell = `<c xmlns="urn:foreign" r="H10"><f>Data!H10</f></c>`
    const foreignColumn = '<col xmlns="urn:foreign" min="1" max="1"/>'
    const xml =
      `<s:worksheet xmlns:s="${namespace}"><s:cols>${foreignColumn}<s:col min="3" max="3" width="15"/></s:cols>` +
      '<s:sheetData><s:row r="2"><s:c r="C2"><s:f>Data!A2</s:f></s:c>' +
      foreignCell +
      '</s:row></s:sheetData></s:worksheet>'
    const moved = applyStructuralOps(
      xml,
      [
        { kind: 'insert-rows', index: 0, count: 1 },
        { kind: 'insert-cols', index: 0, count: 1 },
      ],
      'Data',
    )
    expect(moved).toContain('<s:row r="3"><s:c r="D3"><s:f>Data!B3</s:f></s:c>')
    expect(moved).toContain('<s:col min="4" max="4" width="15"/>')
    expect(moved).toContain(foreignCell)
    expect(moved).toContain(foreignColumn)
  })
})
