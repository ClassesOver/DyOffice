import { describe, expect, it } from 'vitest'

import {
  applySheetPlanToWorkbookXml,
  assertNoSheetScopedDefinedNames,
  definedNamesReferenceSheet,
  definedNamesUseToken,
  parseSheetElements,
  type SheetEditPlan,
} from '../src/gateway/xlsx-sheets'

const sheets =
  '<sheets><sheet name="First" sheetId="1"/><sheet name="Second" sheetId="2"/></sheets>'

function apply(beforeSheets: string, plan: Partial<SheetEditPlan>, afterSheets = ''): string {
  return applySheetPlanToWorkbookXml(
    `<workbook>${beforeSheets}${sheets}${afterSheets}</workbook>`,
    { renames: [], additions: [], removals: [], order: ['Second', 'First'], ...plan },
    [],
  )
}

describe('sheet tab metadata', () => {
  it('reads and reorders only workbook sheet declarations', () => {
    const foreignList = '<e:sheets><e:sheet name="ForeignList" sheetId="9"/></e:sheets>'
    const foreignSheet = '<e:sheet name="ForeignSheet" sheetId="10"/>'
    const first = '<s:sheet name="First" sheetId="1"/>'
    const second = '<s:sheet name="Second" sheetId="2"/>'
    const input = `<s:workbook xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:e="urn:example">${foreignList}<s:sheets>${first}${foreignSheet}${second}</s:sheets></s:workbook>`
    expect(parseSheetElements(input).map(({ name }) => name)).toEqual(['First', 'Second'])
    const output = applySheetPlanToWorkbookXml(input, {
      renames: [], additions: [], removals: [], order: ['Second', 'First'],
    }, [])
    expect(output).toContain(foreignList)
    expect(output).toContain(`<s:sheets>${second}${foreignSheet}${first}</s:sheets>`)
  })

  it('remaps the workbook active tab and preserves extension views', () => {
    const foreignViews = '<e:bookViews><e:workbookView activeTab="0"/></e:bookViews>'
    const foreignView = '<e:workbookView activeTab="0"/>'
    const input = `<workbook xmlns:e="urn:example">${foreignViews}<bookViews><workbookView activeTab="0"/>${foreignView}</bookViews>${sheets}</workbook>`
    const output = applySheetPlanToWorkbookXml(input, {
      renames: [], additions: [], removals: [], order: ['Second', 'First'],
    }, [])
    expect(output).toContain(`${foreignViews}<bookViews><workbookView activeTab="1"/>${foreignView}</bookViews>`)
  })

  it('ignores foreign names when checking duplicates and remapping sheet scopes', () => {
    const foreign = '<e:definedName name="Foreign" localSheetId="0">First!A1</e:definedName>'
    const actual = '<definedName name="Actual" localSheetId="1">Second!A1</definedName>'
    const input = `<workbook xmlns:e="urn:example">${sheets}<definedNames>${foreign}${actual}</definedNames></workbook>`
    expect(() => assertNoSheetScopedDefinedNames(input, 'First')).not.toThrow()
    expect(definedNamesReferenceSheet(input, 'First', new Set())).toBe(false)
    const output = applySheetPlanToWorkbookXml(input, {
      renames: [], additions: [], removals: [], order: ['Second', 'First'],
    }, [])
    expect(output).toContain(foreign + actual.replace('localSheetId="1"', 'localSheetId="0"'))
  })

  it.each([
    ['<bookViews><workbookView/></bookViews>'],
    ["<bookViews><workbookView activeTab = '0'/></bookViews>"],
    ['<bookViews/>'],
    [''],
  ])('preserves the original first active tab on reorder with book views %j', (views) => {
    expect(apply(views, {})).toMatch(
      /<bookViews><workbookView activeTab="1"\s*\/\s*><\/bookViews><sheets><sheet name="Second"/,
    )
  })

  it('selects a visible tab when the active tab is hidden', () => {
    const output = apply('<bookViews><workbookView activeTab="0"/></bookViews>', {
      hiddenChanges: [{ sheetName: 'First', hidden: true }],
    })
    expect(output).toContain('<workbookView activeTab="0"/>')
  })

  it('reindexes every surviving name by its original sheet and drops deleted local scopes', () => {
    const output = apply(
      '',
      { removals: ['First'], order: ['Second'] },
      `<definedNames><definedName name="Discard" localSheetId='0'>First!A1</definedName><definedName name='_xlnm.Print_Area' localSheetId = '1'>Second!$A$1</definedName></definedNames>`,
    )
    expect(output).not.toContain('Discard')
    expect(output).toMatch(/name='_xlnm\.Print_Area' localSheetId="0">Second!\$A\$1/)
  })

  it('ignores single-quoted local scopes only when their sheet is removed', () => {
    const workbook = `<workbook><definedNames><definedName name="Budget" localSheetId='1'>Second!A1+SUM(MyTable[Amt])</definedName></definedNames></workbook>`
    expect(definedNamesReferenceSheet(workbook, 'Second', new Set([1]))).toBe(false)
    expect(definedNamesReferenceSheet(workbook, 'Second', new Set([0]))).toBe(true)
    expect(definedNamesUseToken(workbook, 'MyTable[', new Set([1]))).toBe(false)
    expect(definedNamesUseToken(workbook, 'MyTable[', new Set([0]))).toBe(true)
  })
})
