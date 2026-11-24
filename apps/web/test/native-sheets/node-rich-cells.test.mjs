import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

test('Node XLSX reads rich text and legacy array formula metadata through saves', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-node-xlsx-rich-cells-'))
  let runtime
  t.after(async () => {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  })
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  runtime = await configuredSheetsRuntime(
    {
      DYOFFICE_AUTH_MODE: 'local',
      DYOFFICE_SANDBOX_MODE: 'subprocess',
      DYOFFICE_DEPLOYMENT_ID: randomUUID(),
      DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
      DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
    },
    { enabled: true },
  )
  const native = runtime.sheetsNative
  const zip = await JSZip.loadAsync(
    await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)),
  )
  const path = 'xl/worksheets/sheet1.xml'
  const original = await zip.file(path).async('string')
  const inline =
    '<is><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>Rich</t></r><r><t xml:space="preserve"> &amp; text</t></r><rPh sb="0" eb="4"><t>Annotation</t></rPh></is>'
  const stringPart =
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si/><si><r><rPr><b val="0"/><i/><u val="double"/><strike val="true"/><rFont val="A &amp; B"/><sz val="12.5"/><color indexed="4"/><vertAlign val="superscript"/></rPr><t>Shared</t></r><r><t xml:space="preserve"> two_x000D_\nlines</t></r><rPh sb="0" eb="6"><t>Guide</t></rPh></si><si><t>Plain</t><rPh sb="0" eb="5"><t>Reading</t></rPh></si></sst>'
  zip.file('xl/sharedStrings.xml', stringPart)
  zip.file(
    path,
    original.replace(
      /<sheetData>[\s\S]*?<\/sheetData>/,
      `<sheetData>
    <row r="1"><c r="A1" t="inlineStr">${inline}</c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2"><f ref="A2:B2" t="array">TRANSPOSE(A3:A4)</f><v>12.5</v></c><c r="B2"><v>7.5</v></c>
      <c r="C2"><f t="array" ref="C2">SUM(A3:A4*A3:A4)</f><v>212.5</v></c></row>
    <row r="3"><c r="A3"><v>12.5</v></c></row><row r="4"><c r="A4"><v>7.5</v></c></row>
  </sheetData>`,
    ),
  )
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }
  const plainRun = { bold: false, italic: false, underline: false, strikethrough: false }
  const expected = [
    {
      row: 0,
      column: 0,
      value: 'Rich & text',
      rich: [
        { ...plainRun, text: 'Rich', bold: true, color: '#FF0000' },
        { ...plainRun, text: ' & text' },
      ],
    },
    {
      row: 0,
      column: 1,
      value: 'Shared two\nlines',
      rich: [
        {
          ...plainRun,
          text: 'Shared',
          italic: true,
          underline: true,
          strikethrough: true,
          size: 12.5,
          family: 'A & B',
          color: '#0000FF',
          vertAlign: 'superscript',
        },
        { ...plainRun, text: ' two\nlines' },
      ],
    },
    { row: 0, column: 2, value: 'Plain' },
    { row: 1, column: 0, value: 12.5, formula: '=TRANSPOSE(A3:A4)', arrayRef: 'A2:B2' },
    { row: 1, column: 1, value: 7.5 },
    { row: 1, column: 2, value: 212.5, formula: '=SUM(A3:A4*A3:A4)', arrayRef: 'C2' },
  ]
  const cellDetails = (cells) => cells.map(({ styleIndex: _style, ...cell }) => cell)
  const readCells = async (bytes) =>
    cellDetails((await native.readRange(bytes, 'Acceptance', range)).cells)
  assert.deepEqual(await readCells(source), expected)
  const opened = await native.inspect(source, undefined, true)
  assert.deepEqual(
    cellDetails(opened.openingViewport.result.cells.filter((cell) => cell.row <= 1)),
    expected,
  )
  const formulas = await native.readSheet(source, 'Acceptance', 'formulas')
  assert.deepEqual(cellDetails(formulas.cells), [expected[3], expected[5]])

  const request = sheetsSaveRequest('sheet-1', [{ row: 3, column: 1, writeValue: true, value: 42 }])
  const saved = (
    await native.savePlan(source, await runtime.sheetsWorkbookPlanner(source, request))
  ).bytes
  assert.deepEqual(await readCells(saved), expected)
  const savedZip = await JSZip.loadAsync(saved)
  assert.equal(await savedZip.file('xl/sharedStrings.xml').async('string'), stringPart)
  assert.ok((await savedZip.file(path).async('string')).includes(inline))

  const editMaster = sheetsSaveRequest('sheet-1', [
    { row: 1, column: 0, writeValue: true, value: null, formula: '=TRANSPOSE(A3:A4*2)' },
  ])
  const edited = (
    await native.savePlan(saved, await runtime.sheetsWorkbookPlanner(saved, editMaster))
  ).bytes
  const editedFormulas = await native.readSheet(edited, 'Acceptance', 'formulas')
  assert.deepEqual(cellDetails(editedFormulas.cells), [
    { ...expected[3], formula: '=TRANSPOSE(A3:A4*2)', value: null },
    expected[5],
  ])
})
