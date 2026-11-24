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

test('Node XLSX expands shared formulas and preserves their cached results across saves', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-node-xlsx-formulas-'))
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
  const rows = `<sheetData>
    <row r="2"><c r="A2"><v>10</v></c><c r="B2"><f t="shared" ref="B2:B4" si="0">A2*2</f><v>20</v></c>
      <c r="C2"><f t="shared" si="1" ref="C2:D3">IF(A2&lt;B2,$A2+A$2+$A$2,0)</f><v>30</v></c>
      <c r="D2"><f si="1" t="shared" /><v>40</v></c></row>
    <row r="3"><c r="A3"><v>20</v></c><c r="B3"><f t="shared" si="0"/><v>40</v></c>
      <c r="D3"><f t="shared" si="1"/><v></v></c></row>
    <row r="4"><c r="A4"><v>30</v></c><c r="B4"><f t="shared" si="0"></f><v>60</v></c></row>
  </sheetData>`
  zip.file(path, original.replace(/<sheetData>[\s\S]*?<\/sheetData>/, rows))
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const range = { startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 }
  const expected = [
    [1, 1, '=A2*2', 20],
    [1, 2, '=IF(A2<B2,$A2+A$2+$A$2,0)', 30],
    [1, 3, '=IF(B2<C2,$A2+B$2+$A$2,0)', 40],
    [2, 1, '=A3*2', 40],
    [2, 3, '=IF(B3<C3,$A3+B$2+$A$2,0)', null],
    [3, 1, '=A4*2', 60],
  ]
  const formulaCells = (cells) =>
    cells.map(({ row, column, formula, value }) => [row, column, formula, value])
  const readCells = async (bytes) =>
    formulaCells((await native.readRange(bytes, 'Acceptance', range)).cells)
  const save = async (bytes, changes, formulaValues = []) => {
    const request = sheetsSaveRequest('sheet-1', changes)
    request.formulaValues = formulaValues
    const plan = await runtime.sheetsWorkbookPlanner(bytes, request)
    return (await native.savePlan(bytes, plan)).bytes
  }

  assert.deepEqual(await readCells(source), expected)
  const opening = await native.inspect(source, undefined, true)
  assert.deepEqual(
    formulaCells(opening.openingViewport.result.cells.filter((cell) => cell.column > 0)),
    expected,
  )
  const formulaIndex = await native.readFormulaIndex(source)
  assert.deepEqual(formulaCells(formulaIndex[0].cells), expected)

  const editedReference = await save(
    source,
    [{ row: 2, column: 0, writeValue: true, value: 99 }],
    [{ sheetId: 'sheet-1', row: 2, column: 1, value: 198 }],
  )
  const editedXml = await (await JSZip.loadAsync(editedReference)).file(path).async('string')
  assert.match(editedXml, /<c r="A3"><v>99<\/v><\/c>/)
  assert.match(editedXml, /<c r="B3"><f t="shared" si="0"\/><v>198<\/v><\/c>/)
  const refreshed = expected.map((cell) =>
    cell[0] === 2 && cell[1] === 1 ? [2, 1, '=A3*2', 198] : cell,
  )
  assert.deepEqual(await readCells(editedReference), refreshed)

  const editedMasterAndFollower = await save(editedReference, [
    { row: 1, column: 1, writeValue: true, value: 123 },
    { row: 1, column: 3, writeValue: true, value: null, formula: '=A2+1' },
  ])
  assert.deepEqual(await readCells(editedMasterAndFollower), [
    [1, 1, undefined, 123],
    refreshed[1],
    [1, 3, '=A2+1', null],
    ...refreshed.slice(3),
  ])
  const finalXml = await (await JSZip.loadAsync(editedMasterAndFollower)).file(path).async('string')
  assert.match(finalXml, /<c r="B3"><f>A3\*2<\/f><v>198<\/v><\/c>/)
  assert.match(finalXml, /<c r="B4"><f>A4\*2<\/f><v>60<\/v><\/c>/)

  const workbookWithRows = async (rowsXml) => {
    zip.file(path, original.replace(/<sheetData>[\s\S]*?<\/sheetData>/, rowsXml))
    return zip.generateAsync({ type: 'nodebuffer' })
  }
  const quotedRows = rows.replaceAll(/ (t|si|ref)="([^"]*)"/g, " $1 = '$2'")
  await t.test(
    'keeps followers after replacing a master with quoted formula attributes',
    async () => {
      const input = await workbookWithRows(quotedRows)
      const output = await save(input, [{ row: 1, column: 1, writeValue: true, value: 123 }])
      const xml = await (await JSZip.loadAsync(output)).file(path).async('string')
      assert.equal(XMLValidator.validate(xml), true)
      assert.deepEqual(await readCells(output), [[1, 1, undefined, 123], ...expected.slice(1)])
    },
  )

  await t.test('refreshes text caches on cells with quoted type attributes', async () => {
    const input = await workbookWithRows(quotedRows.replace('<c r="B3">', "<c r='B3' t='str'>"))
    const output = await save(input, [], [{ sheetId: 'sheet-1', row: 2, column: 1, value: '0042' }])
    const xml = await (await JSZip.loadAsync(output)).file(path).async('string')
    assert.equal(XMLValidator.validate(xml), true)
    assert.deepEqual((await readCells(input))[3], [2, 1, '=A3*2', '40'])
    assert.deepEqual((await readCells(output))[3], [2, 1, '=A3*2', '0042'])
  })

  await t.test(
    'translates sheet-qualified refs without shifting structured column names',
    async () => {
      const input = await workbookWithRows(
        rows.replace('A2*2', "SUM(Table1[[#Data],[A1]])+'Sheet [A1]'!A2+A2"),
      )
      assert.deepEqual((await readCells(input))[3], [
        2,
        1,
        "=SUM(Table1[[#Data],[A1]])+'Sheet [A1]'!A3+A3",
        40,
      ])
    },
  )
})
