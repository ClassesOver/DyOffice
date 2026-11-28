import { describe, expect, it } from 'vitest'

import { applyPrintAreas } from '../src/gateway/xlsx-page-setup'
import { renameSheetReferencesInDefinedNames } from '../src/gateway/xlsx-sheets'
import { shiftDefinedNames, StructuralShiftError } from '../src/gateway/xlsx-structure'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

function workbook(names: string): string {
  return `<workbook xmlns="${NS}" xmlns:s="${NS}"><definedNames>${names}</definedNames></workbook>`
}

describe('workbook print names through structural edits', () => {
  it('renames and shifts only names in the workbook namespace', () => {
    const foreignSection = '<e:definedNames><e:definedName>Data!$A$1</e:definedName></e:definedNames>'
    const foreignName = '<e:definedName name="Foreign">Data!$B$2</e:definedName>'
    const input = `<workbook xmlns="${NS}" xmlns:e="urn:example">${foreignSection}<definedNames>${foreignName}<definedName name="Actual">Data!$C$3</definedName></definedNames></workbook>`
    const renamed = renameSheetReferencesInDefinedNames(input, 'Data', 'Renamed')
    const shifted = shiftDefinedNames(renamed, 'Renamed', [{ kind: 'insert-rows', index: 0, count: 1 }])
    expect(shifted).toBe(input.replace('Data!$C$3', 'Renamed!$C$4'))
  })

  it('updates only workbook print settings and preserves the actual title columns', () => {
    const foreignTitles = '<e:definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$Z:$Z</e:definedName>'
    const foreignArea = '<e:definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$88</e:definedName>'
    const actual = '<s:definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$A:$B</s:definedName>'
    const input = `<s:workbook xmlns:s="${NS}" xmlns:e="urn:example"><s:sheets><s:sheet name="Data"/></s:sheets><s:definedNames>${foreignTitles}${foreignArea}${actual}</s:definedNames></s:workbook>`
    expect(applyPrintAreas(input, [{ sheetName: 'Data', printTitles: '2:3', printArea: 'A1:B4' }])).toBe(
      input.replace(actual, actual.replace('Data!$A:$B', "'Data'!$A:$B,'Data'!$2:$3") +
        `<s:definedName name="_xlnm.Print_Area" localSheetId="0">'Data'!$A$1:$B$4</s:definedName>`),
    )
  })

  it('adds and clears a workbook print area independently of a foreign names section', () => {
    const sheets = '<s:sheets><s:sheet name="Data"/></s:sheets>'
    const foreign = '<e:definedNames><e:definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$88</e:definedName></e:definedNames>'
    const input = `<s:workbook xmlns:s="${NS}" xmlns:e="urn:example">${sheets}${foreign}</s:workbook>`
    const saved = applyPrintAreas(input, [{ sheetName: 'Data', printArea: 'A1' }])
    expect(saved).toBe(input.replace(sheets, sheets +
      `<s:definedNames><s:definedName name="_xlnm.Print_Area" localSheetId="0">'Data'!$A$1</s:definedName></s:definedNames>`))
    expect(applyPrintAreas(saved, [{ sheetName: 'Data', printArea: null }])).toBe(input)
  })

  it('shifts aliased print areas and both print title axes', () => {
    const input = workbook(
      `<s:definedName localSheetId='0' name='_xlnm.Print_Area'>'Data'!$B$2:$D$3</s:definedName>` +
        `<s:definedName localSheetId='0' name='_xlnm.Print_Titles'>'Data'!$B:$C,'Data'!$2:$3</s:definedName>`,
    )
    expect(
      shiftDefinedNames(input, 'Data', [
        { kind: 'insert-rows', index: 0, count: 1 },
        { kind: 'insert-cols', index: 0, count: 1 },
      ]),
    ).toBe(
      workbook(
        `<s:definedName localSheetId='0' name='_xlnm.Print_Area'>'Data'!$C$3:$E$4</s:definedName>` +
          `<s:definedName localSheetId='0' name='_xlnm.Print_Titles'>'Data'!$C:$D,'Data'!$3:$4</s:definedName>`,
      ),
    )
  })

  it('renames aliased print names without rewriting nested extension data', () => {
    const extension = '<extLst><ext uri="example"><definedName>Data!A1</definedName></ext></extLst>'
    const input = workbook(
      `<s:definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1</s:definedName>`,
    ).replace('</workbook>', `${extension}</workbook>`)
    expect(renameSheetReferencesInDefinedNames(input, 'Data', 'New Tab')).toBe(
      workbook(
        `<s:definedName name="_xlnm.Print_Area" localSheetId="0">'New Tab'!$A$1</s:definedName>`,
      ).replace('</workbook>', `${extension}</workbook>`),
    )
  })

  it('rewrites print ranges stored as CDATA while preserving comments', () => {
    const input = workbook(
      `<s:definedName name="_xlnm.Print_Area" localSheetId="0"><!-- 'Data & More'!A8 --><![CDATA['Data & More'!$A$8]]></s:definedName>`,
    )
    const shifted = shiftDefinedNames(input, 'Data & More', [
      { kind: 'insert-rows', index: 0, count: 1 },
    ])
    expect(renameSheetReferencesInDefinedNames(shifted, 'Data & More', 'New & More')).toBe(
      workbook(
        `<s:definedName name="_xlnm.Print_Area" localSheetId="0"><!-- 'Data & More'!A8 -->'New &amp; More'!$A$9</s:definedName>`,
      ),
    )
  })

  it('removes a print area when its only range is deleted', () => {
    const input = workbook(
      `<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$8:$B$8</definedName>`,
    )
    expect(shiftDefinedNames(input, 'Data', [{ kind: 'remove-rows', index: 7, count: 1 }])).toBe(
      `<workbook xmlns="${NS}" xmlns:s="${NS}"></workbook>`,
    )
  })

  it('keeps surviving print area components and the other title axis', () => {
    const input = workbook(
      `<s:definedName name="_xlnm.Print_Area" localSheetId="0">'Bob''s, Data'!$A$8:$B$8,'Bob''s, Data'!$C$9:$E$10</s:definedName>` +
        `<s:definedName name="_xlnm.Print_Titles" localSheetId="0">'Bob''s, Data'!$A:$B,'Bob''s, Data'!$8:$8</s:definedName>`,
    )
    expect(
      shiftDefinedNames(input, "Bob's, Data", [{ kind: 'remove-rows', index: 7, count: 1 }]),
    ).toBe(
      workbook(
        `<s:definedName name="_xlnm.Print_Area" localSheetId="0">'Bob''s, Data'!$C$8:$E$9</s:definedName>` +
          `<s:definedName name="_xlnm.Print_Titles" localSheetId="0">'Bob''s, Data'!$A:$B</s:definedName>`,
      ),
    )
  })

  it('still rejects deletion of a reference in an ordinary named formula', () => {
    const input = workbook(
      `<s:definedName name="Total" localSheetId="0">SUM(Data!$A$8)</s:definedName>`,
    )
    expect(() =>
      shiftDefinedNames(input, 'Data', [{ kind: 'remove-rows', index: 7, count: 1 }]),
    ).toThrow(StructuralShiftError)
  })
})
