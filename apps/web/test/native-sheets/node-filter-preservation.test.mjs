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

const input = new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)
const part = 'xl/worksheets/sheet1.xml'
const span = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 }
const top = '<filterColumn colId="0"><top10 top="1" percent="0" val="1"/></filterColumn>'
const dates =
  '<filterColumn colId="2"><filters><dateGroupItem year="2026" dateTimeGrouping="year"/></filters></filterColumn>'
const before = `<autoFilter ref="A1:C3">${top}<filterColumn colId="1"><filters><filter val="25"/></filters></filterColumn>${dates}</autoFilter>`

function filterChange(columns, hiddenRows = []) {
  const request = sheetsSaveRequest('sheet-1', [])
  request.filterStates = [
    {
      sheetId: 'sheet-1',
      filter: { range: span, columns },
      visibilityRange: span,
      hiddenRows,
    },
  ]
  return request
}

test('Web XLSX filter saves preserve unsupported criteria on untouched columns', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-node-xlsx-filter-'))
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
  const source = await readFile(input)
  const save = async (bytes, request) =>
    (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes

  await t.test(
    'keeps Top 1 and date grouping when replacing a different worksheet column',
    async () => {
      const zip = await JSZip.loadAsync(source)
      const original = await zip.file(part).async('string')
      zip.file(
        part,
        original
          .replace('<row r="3">', '<row r="3" hidden="1">')
          .replace('</sheetData>', '</sheetData>' + before),
      )
      const bytes = await zip.generateAsync({ type: 'nodebuffer' })
      const request = filterChange([{ colId: 1, values: ['15'] }], [1])
      const saved = await JSZip.loadAsync(await save(bytes, request))
      const worksheet = await saved.file(part).async('string')
      assert.ok(worksheet.includes(top))
      assert.ok(worksheet.includes(dates))
      assert.match(
        worksheet,
        /<filterColumn colId="1"><filters><filter val="15"\/><\/filters><\/filterColumn>/,
      )
      assert.match(worksheet, /<row r="2" hidden="1">/)
      assert.match(worksheet, /<row r="3" hidden="1">/)
      const reopened = await native.readRange(
        await saved.generateAsync({ type: 'nodebuffer' }),
        'Acceptance',
        span,
      )
      assert.deepEqual(reopened.autoFilterColumns, [{ colId: 1, values: ['15'] }])

      const explicitlyReplace = filterChange([{ colId: 0, values: ['12.5'] }])
      const replaced = await JSZip.loadAsync(await save(bytes, explicitlyReplace))
      const replacedWorksheet = await replaced.file(part).async('string')
      assert.doesNotMatch(replacedWorksheet, /<top10\b/)
      assert.ok(replacedWorksheet.includes(dates))

      const resize = filterChange([{ colId: 1, values: ['15'] }])
      resize.filterStates[0].filter.range = { ...span, endRow: 3 }
      await assert.rejects(
        () => runtime.sheetsWorkbookPlanner(bytes, resize),
        /Invalid workbook input/,
      )

      const remove = filterChange([])
      remove.filterStates[0].filter = null
      const removed = await JSZip.loadAsync(await save(bytes, remove))
      assert.doesNotMatch(await removed.file(part).async('string'), /<autoFilter\b/)
    },
  )

  await t.test('keeps opaque criteria in the table part', async () => {
    const add = sheetsSaveRequest('sheet-1', [])
    add.tableAdditions = [
      {
        sheetId: 'sheet-1',
        area: span,
        name: 'ExistingFilterTable',
        columnNames: ['Revenue', 'Formula', 'Date'],
        bandedRows: true,
      },
    ]
    const zip = await JSZip.loadAsync(await save(source, add))
    const table = zip.file(/^xl\/tables\/table\d+\.xml$/)[0]
    const xml = await table.async('string')
    assert.match(xml, /<autoFilter ref="A1:C3"\/>/)
    zip.file(table.name, xml.replace('<autoFilter ref="A1:C3"/>', before))
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const saved = await JSZip.loadAsync(
      await save(bytes, filterChange([{ colId: 1, values: ['15'] }])),
    )
    const retained = await saved.file(table.name).async('string')
    assert.ok(retained.includes(top))
    assert.ok(retained.includes(dates))
    assert.match(retained, /<filter val="15"\/>/)
    assert.doesNotMatch(await saved.file(part).async('string'), /<autoFilter\b/)
  })

  await t.test(
    'updates the active worksheet filter independently of the filter in a custom view',
    async () => {
      const zip = await JSZip.loadAsync(source)
      const original = await zip.file(part).async('string')
      const view =
        '<customSheetViews><customSheetView guid="{10000000-0000-0000-0000-000000000000}">' +
        before +
        '</customSheetView></customSheetViews>'
      zip.file(part, original.replace('</sheetData>', '</sheetData>' + view))
      const bytes = await zip.generateAsync({ type: 'nodebuffer' })
      assert.equal((await native.readRange(bytes, 'Acceptance', span)).autoFilter, null)

      const filtered = await save(bytes, filterChange([{ colId: 1, values: ['15'] }]))
      const worksheet = await (await JSZip.loadAsync(filtered)).file(part).async('string')
      assert.ok(worksheet.includes(view))
      assert.ok(worksheet.indexOf('<autoFilter') < worksheet.indexOf('<customSheetViews>'))
      const reopened = await native.readRange(filtered, 'Acceptance', span)
      assert.deepEqual(reopened.autoFilterColumns, [{ colId: 1, values: ['15'] }])

      const remove = filterChange([])
      remove.filterStates[0].filter = null
      const cleared = await save(filtered, remove)
      const clearedWorksheet = await (await JSZip.loadAsync(cleared)).file(part).async('string')
      assert.ok(clearedWorksheet.includes(view))
      assert.equal((await native.readRange(cleared, 'Acceptance', span)).autoFilter, null)
    },
  )
})
