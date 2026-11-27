import { expect, it } from 'vitest'

import {
  findTableReferenceInPart,
  rewriteTableReferencesInPart,
} from '../src/gateway/xlsx-table-references'
import { findDefinedNameTableReference } from '../src/gateway/xlsx-sheets'

const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const rewrite = (formula: string) => formula.replaceAll('Sales[', 'Orders[')
const names = new Set(['sales'])

it('renames worksheet table references only in real cells and known worksheet rules', () => {
  const embedded = '<custom><f>SUM(Sales[Total])</f></custom>'
  const outside = '<metadata><f>SUM(Sales[Total])</f></metadata>'
  const xml =
    `<worksheet xmlns="${ns}" xmlns:s="${ns}"><sheetData>` +
    '<row r="1"><c r="A1"><s:f><![CDATA[SUM(Sales[Total])]]></s:f>' +
    embedded +
    '</c></row>' +
    '</sheetData>' +
    outside +
    '</worksheet>'
  const changed = rewriteTableReferencesInPart(xml, 'worksheet', rewrite)
  expect(changed).toContain('<s:f>SUM(Orders[Total])</s:f>')
  expect(changed).toContain(embedded)
  expect(changed).toContain(outside)
})

it('renames calculated and totals formulas only on table columns', () => {
  const nested =
    '<t:custom><t:calculatedColumnFormula>SUM(Sales[Total])</t:calculatedColumnFormula></t:custom>'
  const foreignTable = `<t:tableColumn xmlns:t="urn:other"><t:totalsRowFormula>SUM(Sales[Total])</t:totalsRowFormula></t:tableColumn>`
  const xml =
    `<t:table xmlns:t="${ns}">` +
    nested +
    '<t:tableColumns>' +
    foreignTable +
    '<t:tableColumn id="1" name="Total"><t:calculatedColumnFormula>SUM(Sales[Total])</t:calculatedColumnFormula>' +
    '<t:totalsRowFormula><![CDATA[SUM(Sales[Total])]]></t:totalsRowFormula></t:tableColumn>' +
    '</t:tableColumns></t:table>'
  const changed = rewriteTableReferencesInPart(xml, 'table', rewrite)
  expect(changed).toContain(
    '<t:calculatedColumnFormula>SUM(Orders[Total])</t:calculatedColumnFormula>',
  )
  expect(changed).toContain('<t:totalsRowFormula>SUM(Orders[Total])</t:totalsRowFormula>')
  expect(changed).toContain(nested)
  expect(changed).toContain(foreignTable)
  expect(findTableReferenceInPart(xml, 'table', names)).toBe('sales')
  expect(findTableReferenceInPart(changed, 'table', names)).toBeUndefined()
})

it('detects local references in surviving defined names and ignores literals and external tables', () => {
  const xml =
    '<workbook><definedNames>' +
    '<definedName name="Label">"Sales[Total]"</definedName>' +
    '<definedName name="External">[1]Remote!Sales[Total]</definedName>' +
    '<definedName name="OtherTable">XSALes[Total]</definedName>' +
    '<definedName name="Local" localSheetId="0">SUM(sALes&#91;Total])</definedName>' +
    '</definedNames></workbook>'
  expect(findDefinedNameTableReference(xml, names, new Set())).toBe('sales')
  expect(findDefinedNameTableReference(xml, names, new Set([0]))).toBeUndefined()
})
