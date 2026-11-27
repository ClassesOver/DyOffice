import { describe, expect, it } from 'vitest'

import { applyDvRules, readWorksheetValidations } from '../src/gateway/xlsx-dv'
import { renameSheetReferencesInWorksheet } from '../src/gateway/xlsx-sheets'
import { applyStructuralOps, shiftCrossSheetFormulas } from '../src/gateway/xlsx-structure'
import { rewriteTableReferencesInPart } from '../src/gateway/xlsx-table-references'

const DV_URI = '{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}'
const DV_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const XM_NS = 'http://schemas.microsoft.com/office/excel/2006/main'

function validation(ref: string, first: string, second?: string): string {
  return (
    '<dv:dataValidation type="custom">' +
    `<dv:formula1><m:f>${first}</m:f></dv:formula1>` +
    (second === undefined ? '' : `<dv:formula2><m:f>${second}</m:f></dv:formula2>`) +
    `<m:sqref>${ref}</m:sqref></dv:dataValidation>`
  )
}

function worksheet(sections: string, extensionSibling = '', otherExtensions = ''): string {
  return (
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
    `<extLst xmlns:m="${XM_NS}"><ext uri='${DV_URI}' xmlns:dv='${DV_NS}'>` +
    `${sections}${extensionSibling}</ext>${otherExtensions}</extLst></worksheet>`
  )
}

describe('structural replay of x14 data validations', () => {
  it('moves targets and both formulas in aliased validation markup', () => {
    const rule = validation('E2 E4:E5', 'Data!$A$2:$A$3', 'A2&lt;Other!A2')
    const unrelated =
      `<ext uri="urn:other" xmlns:dv="${DV_NS}">` +
      `<dv:dataValidations count="1">${rule}</dv:dataValidations></ext>`
    const xml = worksheet(
      `<dv:dataValidations count='1'>${rule}</dv:dataValidations>`,
      '',
      unrelated,
    )

    const shifted = applyStructuralOps(
      xml,
      [
        { kind: 'insert-rows', index: 0, count: 1 },
        { kind: 'insert-cols', index: 0, count: 1 },
      ],
      'Data',
    )
    const renamed = renameSheetReferencesInWorksheet(shifted, 'Data', 'New & Tab')

    expect(readWorksheetValidations(renamed)).toMatchObject([
      { sqref: 'F3 F5:F6', formulas: ["'New & Tab'!$B$3:$B$4", 'B3<Other!A2'] },
    ])
    expect(renamed).toContain("<m:f>'New &amp; Tab'!$B$3:$B$4</m:f>")
    expect(renamed).toContain(unrelated)
  })

  it('trims deleted areas, removes empty rules and updates the count', () => {
    const xml = worksheet(
      "<dv:dataValidations count='02'>" +
        validation('A1 C2:C3', 'Other!A2') +
        validation('A2', 'A2') +
        '</dv:dataValidations>',
    )

    const shifted = applyStructuralOps(xml, [{ kind: 'remove-cols', index: 0, count: 1 }], 'Data')

    expect(shifted).toContain("<dv:dataValidations count='1'>")
    expect(readWorksheetValidations(shifted)).toMatchObject([
      { sqref: 'B2:B3', formulas: ['Other!A2'] },
    ])
  })

  it('drops an empty validation section while preserving sibling extension payloads', () => {
    const sibling = '<dv:sibling><m:f>Data!A1</m:f></dv:sibling>'
    const xml = worksheet(
      '<dv:dataValidations count="1">' + validation('A1', 'A1') + '</dv:dataValidations>',
      sibling,
    )

    const shifted = applyStructuralOps(xml, [{ kind: 'remove-rows', index: 0, count: 1 }], 'Data')

    expect(shifted).not.toContain('dataValidations')
    expect(shifted).toContain(sibling + '</ext>')
  })

  it('rewrites qualified source references on a different sheet without moving its targets', () => {
    const xml = worksheet(
      '<dv:dataValidations count="1">' +
        validation('E2', '<![CDATA[Data!$A$2+Other!A2+A2]]>') +
        '</dv:dataValidations>',
    )

    const shifted = shiftCrossSheetFormulas(xml, 'Data', [
      { kind: 'insert-rows', index: 0, count: 1 },
    ])

    expect(readWorksheetValidations(shifted)).toMatchObject([
      { sqref: 'E2', formulas: ['Data!$A$3+Other!A2+A2'] },
    ])
  })

  it('recognizes default namespaces without shifting unrelated extension formulas', () => {
    const unrelated = `<ext uri="urn:other"><f xmlns="${XM_NS}">Data!A2</f></ext>`
    const xml = worksheet(
      `<dataValidations xmlns="${DV_NS}" count="1"><dataValidation type="list">` +
        `<formula1><f xmlns="${XM_NS}">Data!A2</f></formula1>` +
        `<sqref xmlns="${XM_NS}">E2</sqref></dataValidation></dataValidations>`,
      '',
      unrelated,
    )

    const shifted = applyStructuralOps(xml, [{ kind: 'insert-rows', index: 0, count: 1 }], 'Data')
    const renamed = renameSheetReferencesInWorksheet(shifted, 'Data', 'New Tab')

    expect(readWorksheetValidations(renamed)).toMatchObject([
      { sqref: 'E3', formulas: ["'New Tab'!A3"] },
    ])
    expect(renamed).toContain(unrelated)
  })

  it('preserves foreign children when replacing an x14 validation snapshot', () => {
    const foreign = '<dv:dataValidation xmlns:dv="urn:other" name="keep"/>'
    const xml = worksheet(
      `<dv:dataValidations count="1">${foreign}${validation('A1', 'A1')}</dv:dataValidations>`,
    )
    const saved = applyDvRules(xml, [])
    expect(readWorksheetValidations(saved)).toEqual([])
    expect(saved).toContain(foreign)
    expect(saved).toContain('count="0"')
  })
})

describe('legacy worksheet data validation', () => {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const foreignFormula = '<formula1 xmlns="urn:other">Data!A2</formula1>'
  const foreignRule =
    '<dataValidation xmlns="urn:other" sqref="A1"><formula1>Data!A2</formula1></dataValidation>'
  const foreignSection =
    '<dataValidations xmlns="urn:other" count="1">' + foreignRule + '</dataValidations>'
  const sheet =
    `<worksheet xmlns="${ns}" xmlns:s="${ns}"><sheetData/>` +
    foreignSection +
    '<s:dataValidations count="2">' +
    foreignRule +
    '<s:dataValidation type="custom" sqref="A1"><s:formula1>A1</s:formula1></s:dataValidation>' +
    '<s:dataValidation type="custom" sqref="C3">' +
    foreignFormula +
    '<s:formula1><![CDATA[Data!A2+Other!A2+A2]]></s:formula1></s:dataValidation>' +
    '</s:dataValidations></worksheet>'

  it('shifts and renames real ranges and formulas while preserving foreign nodes', () => {
    const shifted = applyStructuralOps(sheet, [{ kind: 'remove-rows', index: 0, count: 1 }], 'Data')
    const renamed = renameSheetReferencesInWorksheet(shifted, 'Data', 'New Tab')
    expect(readWorksheetValidations(renamed)).toMatchObject([
      { sqref: 'C2', formulas: ["'New Tab'!A1+Other!A2+A1"] },
    ])
    expect(renamed).toContain('<s:dataValidations count="1">')
    expect(renamed).toContain(foreignSection)
    expect(renamed).toContain(foreignRule)
    expect(renamed).toContain(foreignFormula)
  })

  it('updates only a referenced sheet on a cross-sheet shift', () => {
    const shifted = shiftCrossSheetFormulas(sheet, 'Data', [
      { kind: 'insert-rows', index: 0, count: 1 },
    ])
    expect(readWorksheetValidations(shifted)).toMatchObject([
      { sqref: 'A1', formulas: ['A1'] },
      { sqref: 'C3', formulas: ['Data!A3+Other!A2+A2'] },
    ])
    expect(shifted).toContain(foreignSection)
    expect(shifted).toContain(foreignFormula)
  })

  it('keeps foreign entries inside a legacy section when saving a rules snapshot', () => {
    const saved = applyDvRules(sheet, [])
    expect(readWorksheetValidations(saved)).toEqual([])
    expect(saved).toContain(
      foreignSection + '<s:dataValidations count="0">' + foreignRule + '</s:dataValidations>',
    )
  })

  it('rewrites structured references only inside real validation rules', () => {
    const formula = 'SUM(Sales[Total])'
    const source = sheet.replaceAll('Data!A2', formula)
    const updated = rewriteTableReferencesInPart(source, 'worksheet', (value) =>
      value.replaceAll('Sales[', 'Orders['),
    )
    expect(readWorksheetValidations(updated)).toMatchObject([
      { sqref: 'A1', formulas: ['A1'] },
      { sqref: 'C3', formulas: ['SUM(Orders[Total])+Other!A2+A2'] },
    ])
    expect(updated).toContain(foreignSection.replaceAll('Data!A2', formula))
    expect(updated).toContain(foreignFormula.replaceAll('Data!A2', formula))
  })
})
