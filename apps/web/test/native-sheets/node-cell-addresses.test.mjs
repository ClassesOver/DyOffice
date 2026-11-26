import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { XMLValidator } from 'fast-xml-parser'
import JSZip from 'jszip'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

test('Node XLSX preserves implicit and quoted coordinates on cell saves', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-node-xlsx-addresses-'))
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
  const zip = await JSZip.loadAsync(
    await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)),
  )
  const path = 'xl/worksheets/sheet1.xml'
  const xml = await zip.file(path).async('string')
  const data = `<sheetData>
    <row r="1"><c r="A1"><v>11</v></c><c><v>22</v></c><c r='C1'><v>33</v></c><c r="D1"><v>44</v></c></row>
    <row r = '7'><c><v>70</v></c><c audit:probe="keep r='K7'" r='E7' s="1"><v>75</v></c><c s="1"><v>76</v></c></row>
    <row><c r = "B8"><v>82</v></c><c><v>83</v></c></row>
    <row r='12'/><row><c><v>131</v></c></row>
  </sheetData>`
  zip.file(
    path,
    xml
      .replace('<worksheet ', '<worksheet xmlns:audit="urn:dyoffice:test" ')
      .replace(/<sheetData>[\s\S]*?<\/sheetData>/, data),
  )
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const native = runtime.sheetsNative
  const range = { startRow: 0, endRow: 13, startColumn: 0, endColumn: 10 }
  const read = async (bytes) => (await native.readRange(bytes, 'Acceptance', range)).cells
  const cells = (records) => records.map(({ row, column, value }) => [row, column, value])
  const unchanged = [
    [0, 0, 11],
    [0, 1, 22],
    [0, 2, 33],
    [0, 3, 44],
    [6, 0, 70],
    [6, 4, 75],
    [6, 5, 76],
    [7, 1, 82],
    [7, 2, 83],
    [12, 0, 131],
  ]

  const request = sheetsSaveRequest('sheet-1', [
    { row: 0, column: 1, writeValue: true, value: 77 },
    { row: 6, column: 5, writeValue: true, value: 88 },
    { row: 11, column: 1, writeValue: true, value: 122 },
  ])
  const output = (
    await native.savePlan(source, await runtime.sheetsWorkbookPlanner(source, request))
  ).bytes
  const savedXml = await (await JSZip.loadAsync(output)).file(path).async('string')
  assert.equal(XMLValidator.validate(savedXml), true)
  assert.match(savedXml, /audit:probe="keep r='K7'"/)
  const before = await read(source)
  const after = await read(output)
  assert.deepEqual(cells(before), unchanged)
  assert.deepEqual(cells(after), [
    [0, 0, 11],
    [0, 1, 77],
    [0, 2, 33],
    [0, 3, 44],
    [6, 0, 70],
    [6, 4, 75],
    [6, 5, 88],
    [7, 1, 82],
    [7, 2, 83],
    [11, 1, 122],
    [12, 0, 131],
  ])
  const styles = (records) =>
    records.filter(({ row }) => row === 6).map(({ column, styleIndex }) => [column, styleIndex])
  assert.deepEqual(styles(before), [
    [0, 0],
    [4, 1],
    [5, 1],
  ])
  assert.deepEqual(styles(after), styles(before))

  await t.test('reads and edits grid cells only in SpreadsheetML worksheet data', async () => {
    const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    const foreignCell = '<c xmlns="urn:example:extension" r="B1"><v>900</v></c>'
    const foreignData = '<sheetData xmlns="urn:example:extension"><row r="2"><c><v>902</v></c></row></sheetData>'
    zip.file(path, `<worksheet xmlns="${spreadsheet}" xmlns:a="urn:example:extension">
      <sheetData>
        <row r="1">
          <c r="A1"><v>11</v></c>
          ${foreignCell}
          <c><v xmlns="urn:example:extension">999</v><a:f>1+1</a:f><v>22</v></c>
          <c t="inlineStr"><is><t>Real</t><t xmlns="urn:example:extension">Decoy</t></is></c>
        </row>
      </sheetData>
      <extLst><ext uri="urn:example:extension"><payload xmlns="urn:example:extension">
        <c r="A1"><v>901</v></c>
        ${foreignData}
      </payload></ext></extLst>
    </worksheet>`)
    const original = await zip.generateAsync({ type: 'nodebuffer' })
    assert.deepEqual(cells(await read(original)), [
      [0, 0, 11],
      [0, 1, 22],
      [0, 2, 'Real'],
    ])
    const edit = sheetsSaveRequest('sheet-1', [{ row: 0, column: 1, writeValue: true, value: 33 }])
    const result = (await native.savePlan(original, await runtime.sheetsWorkbookPlanner(original, edit))).bytes
    const editedXml = await (await JSZip.loadAsync(result)).file(path).async('string')
    assert.equal(XMLValidator.validate(editedXml), true)
    assert.ok(editedXml.includes(foreignCell))
    assert.ok(editedXml.includes(foreignData))
    assert.deepEqual(cells(await read(result)), [
      [0, 0, 11],
      [0, 1, 33],
      [0, 2, 'Real'],
    ])
  })
})
