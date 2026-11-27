import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { workbookRowOutlineResultSchema } from '../../../sheets/src/shared/desktop-api.ts'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

const inputFile = new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)
const worksheetPart = 'xl/worksheets/sheet1.xml'
const foreignSparkline = '<x14:sparkline xmlns:x14="urn:example:foreign"><xm:f>Acceptance!B2:B3</xm:f><xm:sqref>E2</xm:sqref></x14:sparkline>'
const sparkline = `<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">
  <x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">
    <x14:sparklineGroup type="column"><x14:colorSeries rgb="FF123456"/><x14:colorNegative rgb="FFAA0000"/>
      <x14:sparklines>
        <x14:sparkline><xm:f><![CDATA['Acceptance'!$A$2:$A$3]]></xm:f><xm:sqref>D2</xm:sqref></x14:sparkline>
        ${foreignSparkline}
        <x14:sparkline><xm:f>Acceptance!A2:A3</xm:f><xm:sqref>not-a-cell</xm:sqref></x14:sparkline>
      </x14:sparklines>
    </x14:sparklineGroup>
  </x14:sparklineGroups>
</ext></extLst>`
const range = { startRow: 0, endRow: 12, startColumn: 0, endColumn: 6 }

test('Node XLSX reopens worksheet outlines and existing sparklines after a value save', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-node-xlsx-layout-'))
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

  const zip = await JSZip.loadAsync(await readFile(inputFile))
  const worksheet = await zip.file(worksheetPart).async('string')
  zip.file(
    worksheetPart,
    worksheet
      .replace(
        '<dimension ',
        '<sheetPr><outlinePr summaryBelow="0" summaryRight="false"/></sheetPr><dimension ',
      )
      .replace('width="18" customWidth="1"', 'width="18" customWidth="1" outlineLevel="1"')
      .replace('</cols>', '<col min="7" max="7" collapsed="1"/></cols>')
      .replace(
        '</sheetData>',
        '<row r="7" hidden="1"/><row r="8" outlineLevel="2" hidden="1"/>' +
          '<row r="9" outlineLevel="2"/><row r="10" collapsed="1"/>' +
          '<row r="11" s="1" ht="20"/><row r="12" s="1" customFormat="0"><c r="A12" s="1"><v>10</v></c></row>' +
          '<row r="13" s="1" customFormat="true"/></sheetData>',
      )
      .replace('</worksheet>', sparkline + '</worksheet>'),
  )
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const native = runtime.sheetsNative

  async function assertImported(bytes) {
    const file = await native.inspect(bytes, undefined, true)
    const sheet = file.sheets[0]
    assert.deepEqual(sheet.sparklines, [
      {
        type: 'column',
        color: '#123456',
        negativeColor: '#AA0000',
        cells: [{ cell: 'D2', sourceRef: "'Acceptance'!$A$2:$A$3" }],
      },
    ])
    assert.equal(sheet.outlineLevelRow, 2)
    assert.equal(sheet.outlineLevelCol, 1)
    assert.equal(sheet.outlineSummaryBelow, false)
    assert.equal(sheet.outlineSummaryRight, false)
    assert.equal(sheet.columnWidths[0].outlineLevel, 1)
    assert.equal(sheet.columnWidths[1].collapsed, true)
    const rows = await native.readRange(bytes, sheet.name, range)
    assert.equal(rows.rows.find((row) => row.row === 8).outlineLevel, 2)
    assert.equal(rows.rows.find((row) => row.row === 9).collapsed, true)
    assert.equal(rows.rows.find((row) => row.row === 10).height, 20)
    assert.equal(rows.rows.find((row) => row.row === 10).styleIndex, undefined)
    assert.equal(
      rows.rows.find((row) => row.row === 11),
      undefined,
    )
    assert.equal(rows.cells.find((cell) => cell.row === 11 && cell.column === 0).styleIndex, 1)
    assert.equal(rows.rows.find((row) => row.row === 12).styleIndex, 1)
    const outline = workbookRowOutlineResultSchema.parse(
      await native.readSheet(bytes, sheet.name, 'outline'),
    )
    assert.deepEqual(
      outline.rows.map((row) => [row.row, row.level, !!row.collapsed, !!row.hidden]),
      [
        [7, 2, false, true],
        [8, 2, false, false],
        [9, 0, true, false],
      ],
    )
    assert.equal(outline.indexingComplete, true)
    return sheet
  }

  const sheet = await assertImported(source)
  const savedInput = await JSZip.loadAsync(source)
  const sourceXml = await savedInput.file(worksheetPart).async('string')
  savedInput.file(
    worksheetPart,
    sourceXml.replace("<![CDATA['Acceptance'!$A$2:$A$3]]>", '&apos;Acceptance&apos;!$A$2:$A$3'),
  )
  const editable = await savedInput.generateAsync({ type: 'nodebuffer' })
  const request = sheetsSaveRequest(sheet.id, [{ row: 1, column: 0, writeValue: true, value: 101 }])
  const plan = await runtime.sheetsWorkbookPlanner(editable, request)
  const saved = (await native.savePlan(editable, plan)).bytes
  await assertImported(saved)
  assert.equal(
    (await native.readRange(saved, sheet.name, range)).cells.find(
      (cell) => cell.row === 1 && cell.column === 0,
    ).value,
    101,
  )

  await t.test('adds a real sparkline on a target used by an unrelated element', async () => {
    const sparklineRequest = sheetsSaveRequest(sheet.id, [])
    sparklineRequest.sparklineAdditions = [{
      sheetId: sheet.id, type: 'line', cells: [{ cell: 'E2', sourceRef: 'Acceptance!C2:C3' }],
    }]
    const plan = await runtime.sheetsWorkbookPlanner(saved, sparklineRequest)
    const result = (await native.savePlan(saved, plan)).bytes
    const xml = await (await JSZip.loadAsync(result)).file(worksheetPart).async('string')
    assert.ok(xml.includes(foreignSparkline))
    const metadata = (await native.inspect(result, undefined, true)).sheets[0]
    assert.deepEqual(metadata.sparklines.flatMap(group => group.cells), [
      { cell: 'D2', sourceRef: "'Acceptance'!$A$2:$A$3" },
      { cell: 'E2', sourceRef: 'Acceptance!C2:C3' },
    ])
  })

  await t.test('reads and saves only SpreadsheetML column layout and outline settings', async () => {
    const foreign = 'xmlns="urn:example:layout"'
    const properties = `<sheetPr ${foreign}><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>`
    const outline = `<outlinePr ${foreign} summaryBelow="1"/>`
    const format = `<sheetFormatPr ${foreign} defaultRowHeight="90" defaultColWidth="90" outlineLevelCol="7"/>`
    const columns = `<cols ${foreign}><col min="1" max="6" width="90" outlineLevel="7"/></cols>`
    const column = `<col ${foreign} min="2" max="2" width="80" hidden="1" outlineLevel="6"/>`
    zip.file(worksheetPart, worksheet
      .replace('<dimension ', properties + `<sheetPr>${outline}<outlinePr summaryBelow="0"/></sheetPr><dimension `)
      .replace('<sheetFormatPr defaultRowHeight="15"/>', format + '<sheetFormatPr defaultRowHeight="18" defaultColWidth="13"/>')
      .replace('<cols>', columns + `<cols>${column}`))
    const input = await zip.generateAsync({ type: 'nodebuffer' })
    const initial = (await native.inspect(input)).sheets[0]
    assert.deepEqual([initial.defaultRowHeight, initial.defaultColumnWidth, initial.outlineSummaryBelow], [18, 13, false])
    assert.deepEqual(initial.columnWidths.map(({ startColumn, endColumn, width }) => [startColumn, endColumn, width]), [[0, 5, 18]])
    const edit = sheetsSaveRequest(sheet.id, [])
    edit.structuralOps = [
      { sheetId: sheet.id, kind: 'set-col-size', start: 1, end: 1, size: 24 },
      { sheetId: sheet.id, kind: 'set-cols-hidden', start: 1, end: 1, hidden: true },
      { sheetId: sheet.id, kind: 'set-cols-outline', start: 1, end: 1, level: 2 },
      { sheetId: sheet.id, kind: 'set-outline-pr', summaryBelow: true, summaryRight: false },
    ]
    const result = (await native.savePlan(input, await runtime.sheetsWorkbookPlanner(input, edit))).bytes
    const xml = await (await JSZip.loadAsync(result)).file(worksheetPart).async('string')
    for (const preserved of [properties, outline, format, columns, column]) assert.ok(xml.includes(preserved), preserved)
    const edited = (await native.inspect(result)).sheets[0]
    assert.deepEqual([edited.outlineLevelCol, edited.outlineSummaryBelow, edited.outlineSummaryRight], [2, undefined, false])
    assert.deepEqual(edited.columnWidths.map(({ startColumn, endColumn, width, hidden, outlineLevel }) =>
      [startColumn, endColumn, width, hidden, outlineLevel]), [
      [0, 0, 18, false, undefined],
      [1, 1, 24, true, 2],
      [2, 5, 18, false, undefined],
    ])
  })

  await t.test('styles existing and missing grid rows without touching foreign rows', async () => {
    const foreignRow = '<row xmlns="urn:example:layout" r="4" ht="90" outlineLevel="7"/>'
    const comment = '<!-- <row r="6" /> -->'
    const extension = '<extLst><ext uri="urn:example:layout"><row xmlns="urn:example:layout" r="5" ht="91"/></ext></extLst>'
    zip.file(worksheetPart, worksheet
      .replace('<row r="2">', "<row r=\"2\" ht='21' customHeight='1' hidden='1' outlineLevel='1'>")
      .replace('</sheetData>', foreignRow + comment + '</sheetData>')
      .replace('</worksheet>', extension + '</worksheet>'))
    const input = await zip.generateAsync({ type: 'nodebuffer' })
    const save = async (bytes, structuralOps) => {
      const request = sheetsSaveRequest(sheet.id, [])
      request.structuralOps = structuralOps.map((op) => ({ sheetId: sheet.id, ...op }))
      return (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
    }
    const saved = await save(input, [
      { kind: 'set-row-size', start: 1, end: 5, size: 24 },
      { kind: 'set-rows-hidden', start: 1, end: 5, hidden: true },
      { kind: 'set-rows-outline', start: 1, end: 5, level: 2 },
    ])
    const savedXml = await (await JSZip.loadAsync(saved)).file(worksheetPart).async('string')
    assert.equal(XMLValidator.validate(savedXml), true)
    const cleared = await save(saved, [
      { kind: 'set-row-size', start: 1, end: 1, size: null },
      { kind: 'set-rows-hidden', start: 1, end: 1, hidden: false },
      { kind: 'set-rows-outline', start: 1, end: 1, level: 0 },
    ])
    for (const bytes of [saved, cleared]) {
      const xml = await (await JSZip.loadAsync(bytes)).file(worksheetPart).async('string')
      for (const preserved of [foreignRow, comment, extension]) assert.ok(xml.includes(preserved), preserved)
    }
    const layout = async (bytes) => (await native.readRange(bytes, sheet.name, range)).rows
      .map(({ row, height, hidden, outlineLevel }) => [row, height, hidden, outlineLevel])
    const expected = [1, 2, 3, 4, 5].map((row) => [row, 24, true, 2])
    assert.deepEqual(await layout(saved), expected)
    assert.deepEqual(await layout(cleared), expected.slice(1))
  })
})
