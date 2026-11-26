import { describe, expect, it } from 'vitest'

import {
  applySheetPlanToWorkbookXml,
  assertNoSheetScopedDefinedNames,
  definedNamesReferenceSheet,
  definedNamesUseToken,
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
