import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { tmpdir } from 'node:os'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'
const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
const sheetPart = 'xl/worksheets/sheet1.xml'
const workbookPart = 'xl/workbook.xml'
const range = { startRow: 0, endRow: 6, startColumn: 0, endColumn: 8 }
const insert = (kind, index = 0, count = 1) => ({ sheetId: 'sheet-1', kind, index, count })
async function book(parts) {
  const zip = await JSZip.loadAsync(original)
  for (const [path, change] of Object.entries(parts))
    zip.file(path, change(await zip.file(path).async('string')))
  return zip.generateAsync({ type: 'nodebuffer' })
}
test(
  'Web XLSX moves page breaks and worksheet dimensions during structural saves',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-structural-print-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await buildSheetsGateway(join(dir, 'gateway.mjs'))
    const runtime = await configuredSheetsRuntime(
      {
        DYOFFICE_AUTH_MODE: 'local',
        DYOFFICE_SANDBOX_MODE: 'subprocess',
        DYOFFICE_DEPLOYMENT_ID: randomUUID(),
        DYOFFICE_XLSX_NODE_ENGINE: join(dir, 'xlsx-node-engine.mjs'),
        DYOFFICE_XLSX_GATEWAY_RUNNER: join(dir, 'gateway-process.mjs'),
      },
      { enabled: true },
    )
    t.after(() => runtime.close())
    const native = runtime.sheetsNative
    const save = async (bytes, attrs) => {
      const request = { ...sheetsSaveRequest('sheet-1', []), ...attrs }
      return (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request)))
        .bytes
    }
    const dimensions = async (bytes) => {
      const { rowCount, columnCount } = (await native.inspect(bytes)).sheets[0]
      return [rowCount, columnCount]
    }
    await t.test(
      'moves existing row and column breaks on insertion and removes them with deleted lines',
      async () => {
        const breaks = ['rowBreaks', 'colBreaks']
          .map(
            (tag, i) =>
              `<${tag} count="1" manualBreakCount="1"><brk id="${i + 2}" min="${i ? 3 : 0}" max="${i ? 5 : 16383}" man="1"/></${tag}>`,
          )
          .join('')
        const input = await book({
          [sheetPart]: (xml) => xml.replace('<drawing ', breaks + '<drawing '),
        })
        const saved = await save(input, {
          structuralOps: [insert('insert-rows'), insert('insert-cols')],
        })
        const result = await native.readRange(saved, 'Acceptance', range)
        const moved = result.cells.find((cell) => cell.value === 12.5)
        assert.deepEqual([moved.row, moved.column], [2, 1])
        assert.deepEqual([result.rowBreaks, result.colBreaks], [[3], [4]])
        const afterInsert = await (await JSZip.loadAsync(saved)).file(sheetPart).async('string')
        assert.match(afterInsert, /<brk id="3" min="0" max="16383" man="1"\/>/)
        assert.match(afterInsert, /<brk id="4" min="4" max="6" man="1"\/>/)
        const altered = await save(saved, {
          structuralOps: [insert('remove-rows', 3), insert('remove-cols', 4)],
        })
        const withoutBreaks = await native.readRange(altered, 'Acceptance', range)
        assert.deepEqual([withoutBreaks.rowBreaks, withoutBreaks.colBreaks], [[], []])
        const xml = await (await JSZip.loadAsync(altered)).file(sheetPart).async('string')
        assert.doesNotMatch(xml, /<(?:row|col)Breaks\b/)
      },
    )
    await t.test(
      'shrinks single- and double-quoted dimensions on row and column removal',
      async () => {
        const fixture = (quote) =>
          book({
            [sheetPart]: (xml) =>
              xml.replace('<dimension ref="A1:F3"/>', `<dimension ref=${quote}A1:Z400${quote}/>`),
          })
        const request = {
          structuralOps: [insert('remove-rows', 100, 10), insert('remove-cols', 20, 2)],
        }
        const saved = await save(await fixture("'"), request)
        const control = await save(await fixture('"'), request)
        assert.deepEqual(await dimensions(saved), [390, 24])
        assert.deepEqual(await dimensions(control), [390, 24])
      },
    )
    await t.test(
      'clears deleted pending title rows while keeping file-backed title columns',
      async () => {
        const input = await book({
          [sheetPart]: (xml) =>
            xml.replace('</sheetData>', '<row r="8"><c r="A8"><v>42</v></c></row></sheetData>'),
          [workbookPart]: (xml) =>
            xml.replace(
              '</definedNames>',
              '<definedName name="_xlnm.Print_Titles" localSheetId="0">\'Acceptance\'!$2:$3,\'Acceptance\'!$B:$C</definedName></definedNames>',
            ),
        })
        const saved = await save(input, {
          structuralOps: [insert('remove-rows', 7)],
          pageSetupStates: [{ sheetId: 'sheet-1', clearPrintTitleRows: true }],
        })
        const { printTitles } = (await native.inspect(saved)).sheets[0]
        assert.equal(printTitles, "'Acceptance'!$B:$C")
      },
    )
  },
)
