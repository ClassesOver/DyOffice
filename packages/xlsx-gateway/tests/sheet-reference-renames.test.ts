import { expect, it } from 'vitest'

import {
  chartReferencesSheet,
  createSheetReferenceRenamer,
  formulaReferencesSheet,
  renameSheetInFormula,
  worksheetReferencesSheet,
} from '../src/gateway/xlsx-sheets'

const rename = [
  { sheetName: 'Data', newName: 'Summary' },
  { sheetName: 'Summary', newName: 'Bright & Clear' },
]

it('recognizes double quotes in sheet names and leaves escaped formula strings alone', () => {
  const formula = `='Q"1''s'!A1&"'Q""1''s'!A1"&'Q"1''s'!B2`
  expect(renameSheetInFormula(formula, `Q"1's`, 'Quarter')).toBe(
    `=Quarter!A1&"'Q""1''s'!A1"&Quarter!B2`,
  )
  expect(formulaReferencesSheet(formula, `Q"1's`)).toBe(true)
  expect(formulaReferencesSheet(`="'Q""1''s'!A1"`, `Q"1's`)).toBe(false)
})

it('does not treat an apostrophe escape in a table reference as a sheet qualifier', () => {
  for (const text of [`=Table1['#Region]&"Data!A1"`, `=Table1['#Region]&"X'!A1"&"Data!A1"`]) {
    expect(renameSheetInFormula(`${text}&Data!A2`, 'Data', 'Summary')).toBe(`${text}&Summary!A2`)
    expect(formulaReferencesSheet(text, 'Data')).toBe(false)
  }
})

it('recognizes chart formula elements by their namespace and leaves foreign elements alone', () => {
  const chart =
    '<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:ext="urn:foreign">' +
    '<chart><numRef><f>Data!A1</f></numRef></chart><ext:f>Summary!B2</ext:f></chartSpace>'
  expect(createSheetReferenceRenamer(rename).chart(chart)).toBe(
    chart.replace('Data!A1', 'Summary!A1'),
  )
  expect(chartReferencesSheet(chart, 'Data')).toBe(true)
  expect(chartReferencesSheet(chart, 'Summary')).toBe(false)
})

it('rewrites chart series and pivot sources using their original sheet names', () => {
  const renamer = createSheetReferenceRenamer(rename)
  expect(renamer.chart('<c:f>Data!$A$2:$A$4</c:f><c:f>Summary!$B$2:$B$4</c:f>')).toBe(
    "<c:f>Summary!$A$2:$A$4</c:f><c:f>'Bright &amp; Clear'!$B$2:$B$4</c:f>",
  )
  const cache = (sheet: string) =>
    '<pivotCacheDefinition><cacheSource type="worksheet">' +
    `<worksheetSource sheet="${sheet}" ref="A1:B4"/></cacheSource></pivotCacheDefinition>`
  expect(renamer.pivotCache(cache('Data'))).toBe(cache('Summary'))
  expect(renamer.pivotCache(cache('Summary'))).toBe(cache('Bright &amp; Clear'))
})

it('keeps cached extension formulas out of chart updates and sheet-deletion checks', () => {
  const namespace = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
  const aliased = `<v:extLst><v:ext uri="urn:private"><v:numRef><v:f>Summary!B2</v:f></v:numRef></v:ext></v:extLst>`
  const foreign = '<ext:cache><v:numRef><v:f>Summary!B3</v:f></v:numRef></ext:cache>'
  const alternate =
    '<mc:AlternateContent><mc:Choice Requires="v"><v:strRef><v:f>Data!A2</v:f></v:strRef></mc:Choice>' +
    '<mc:Fallback><v:numRef><v:f>Data!A3</v:f></v:numRef></mc:Fallback></mc:AlternateContent>'
  const chart =
    `<v:chartSpace xmlns:v="${namespace}" xmlns:ext="urn:private" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    '<v:chart><v:numRef><v:f>Data!A1</v:f></v:numRef>' +
    alternate +
    foreign +
    '</v:chart>' +
    aliased +
    '</v:chartSpace>'
  expect(createSheetReferenceRenamer(rename).chart(chart)).toBe(
    chart.replaceAll('Data!A', 'Summary!A'),
  )
  expect(chartReferencesSheet(chart, 'Data')).toBe(true)
  expect(chartReferencesSheet(chart, 'Summary')).toBe(false)
})

it('rewrites only local sheet references and checks the same scope before deletion', () => {
  const source =
    '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>' +
    '<row><c><f ca="1">[1]Data!A1&amp;"Data!A1"</f></c></row></sheetData>' +
    '<hyperlinks><hyperlink ref="A2" r:id="rId1" location="Data!A2"/></hyperlinks>' +
    '<extLst><ext uri="unrelated"><f>Data!A1</f></ext></extLst></worksheet>'
  expect(createSheetReferenceRenamer(rename).worksheet(source)).toBe(source)
  expect(worksheetReferencesSheet(source, 'Data')).toBe(false)
  expect(
    worksheetReferencesSheet(
      source.replace('r:id="rId1" location="Data!A2"', 'location="Data!A2"'),
      'Data',
    ),
  ).toBe(true)
})
