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

  await t.test('uses defined name declarations when adding and renaming tables', async () => {
    const zip = await JSZip.loadAsync(source)
    const workbookPath = 'xl/workbook.xml'
    const comment = '<!-- <definedName name="CommentOnly">1</definedName> -->'
    const hidden = "<definedName name='Con&#102;lict' hidden='1'>1</definedName>"
    zip.file(workbookPath, (await zip.file(workbookPath).async('string')).replace('</definedNames>',
      comment + hidden + '</definedNames>'))
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const request = sheetsSaveRequest('sheet-1', [])
    request.tableAdditions = [{
      sheetId: 'sheet-1', area: span, name: 'Conflict',
      columnNames: ['Revenue', 'Formula', 'Date'], bandedRows: true,
    }]
    await assert.rejects(() => save(bytes, request), { statusCode: 400 })
    request.definedNamesState = { names: [{ name: 'Revenue', formula: 'Acceptance!$A$2:$A$3' }], preserveNames: [] }
    await assert.rejects(() => save(bytes, request), { statusCode: 400 })
    request.tableAdditions[0].name = 'CommentOnly'
    const saved = await save(bytes, request)
    assert.equal((await native.inspect(saved)).sheets[0].tables[0].name, 'CommentOnly')
    const rename = sheetsSaveRequest('sheet-1', [])
    rename.tableEdits = [{ sheetId: 'sheet-1', tableName: 'CommentOnly', name: 'CONFLICT' }]
    await assert.rejects(() => save(saved, rename), { statusCode: 400 })
    const workbook = await (await JSZip.loadAsync(saved)).file(workbookPath).async('string')
    assert.ok(workbook.includes(comment) && workbook.includes(hidden))

    const referenced = await JSZip.loadAsync(saved)
    const worksheet = await referenced.file(part).async('string')
    referenced.file(part, worksheet.replace('</sheetData>',
      '<row r="5"><c r="A5"><f>SUM(CommentOnly[Revenue])</f><v>20</v></c></row></sheetData>'))
    rename.tableEdits[0].name = 'RenamedTable'
    const renamed = await save(await referenced.generateAsync({ type: 'nodebuffer' }), rename)
    const reopened = await native.readRange(renamed, 'Acceptance',
      { startRow: 4, endRow: 4, startColumn: 0, endColumn: 0 })
    assert.equal(reopened.cells[0].formula, '=SUM(RenamedTable[Revenue])')
  })

  await t.test('validates the table and defined names in the final save batch', async (t) => {
    const table = (name) => ({ sheetId: 'sheet-1', area: span, name,
      columnNames: ['Revenue', 'Formula', 'Date'], bandedRows: true })
    const takeName = (name) => ({ names: [{ name, formula: 'Acceptance!$A$1' }], preserveNames: [] })
    await t.test('rejects a newly defined name colliding with an added table', async () => {
      const request = sheetsSaveRequest('sheet-1', [])
      request.tableAdditions = [table('BatchName')]
      request.definedNamesState = takeName('batchname')
      await assert.rejects(() => save(source, request), { statusCode: 400 })
    })
    await t.test('lets a table take a name freed by the snapshot in the same save', async () => {
      const zip = await JSZip.loadAsync(source)
      const path = 'xl/workbook.xml'
      zip.file(path, (await zip.file(path).async('string')).replace('</definedNames>',
        '<definedName name="FreedName">Acceptance!$A$1</definedName></definedNames>'))
      const request = sheetsSaveRequest('sheet-1', [])
      request.tableAdditions = [table('FreedName')]
      request.definedNamesState = takeName('Revenue')
      const saved = await save(await zip.generateAsync({ type: 'nodebuffer' }), request)
      const metadata = await native.inspect(saved)
      assert.equal(metadata.sheets[0].tables[0].name, 'FreedName')
      assert.deepEqual(metadata.definedNames.map(({ name }) => name), ['Revenue'])

      const conflict = sheetsSaveRequest('sheet-1', [])
      conflict.definedNamesState = takeName('FREEDNAME')
      await assert.rejects(() => save(saved, conflict), { statusCode: 400 })
      conflict.tableEdits = [{ sheetId: 'sheet-1', tableName: 'FreedName', remove: true }]
      const converted = await native.inspect(await save(saved, conflict))
      assert.deepEqual(converted.sheets[0].tables, [])
      assert.deepEqual(converted.definedNames.map(({ name }) => name), ['FREEDNAME'])
    })
  })

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

  await t.test('reads basic values alongside a date group and preserves the group on a different column edit', async () => {
    const mixed = "<filterColumn colId='0'><filters blank='1'><filter val='Open &amp; ready'/><dateGroupItem year='2026' month='2' dateTimeGrouping='month'/></filters></filterColumn>"
    const oversized = '<filterColumn colId="2"><filters><filter val="Open"/><filter val="' +
      'a'.repeat(32_768) + '"/><dateGroupItem year="2026" dateTimeGrouping="year"/></filters></filterColumn>'
    const zip = await JSZip.loadAsync(source)
    const original = await zip.file(part).async('string')
    zip.file(part, original.replace('</sheetData>', '</sheetData><autoFilter ref="A1:C3">' + mixed +
      '<filterColumn colId="1"><filters><filter val="25"/></filters></filterColumn>' + oversized + '</autoFilter>'))
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    const { autoFilterColumns } = await native.readRange(bytes, 'Acceptance', span)
    assert.deepEqual(autoFilterColumns, [
      { colId: 0, values: ['Open & ready'], blank: true }, { colId: 1, values: ['25'] },
    ])
    const ordinary = await save(bytes, sheetsSaveRequest('sheet-1', [{ row: 1, column: 2, value: 19, writeValue: true }]))
    assert.ok((await (await JSZip.loadAsync(ordinary)).file(part).async('string')).includes(mixed))
    const edited = await save(bytes, filterChange([autoFilterColumns[0], { colId: 1, values: ['15'] }]))
    const editedXml = await (await JSZip.loadAsync(edited)).file(part).async('string')
    assert.ok(editedXml.includes(mixed))
    assert.ok(editedXml.includes(oversized))
    const replaced = await save(edited, filterChange([{ colId: 0, values: ['Closed'] }]))
    const replacedXml = await (await JSZip.loadAsync(replaced)).file(part).async('string')
    assert.equal([...replacedXml.matchAll(/<dateGroupItem\b/g)].length, 1)
    assert.ok(replacedXml.includes(oversized))
  })

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
    'routes a filter into a single-quoted table and excludes the totals row',
    async () => {
      const add = sheetsSaveRequest('sheet-1', [])
      add.tableAdditions = [{
        sheetId: 'sheet-1', area: span, name: 'QuotedTotals',
        columnNames: ['Revenue', 'Formula', 'Date'], bandedRows: true,
        totalsRow: true, filterButton: false,
      }]
      const zip = await JSZip.loadAsync(await save(source, add))
      const table = zip.file(/^xl\/tables\/table\d+\.xml$/)[0]
      const comment = '<!-- <table ref="Z1:Z4" totalsRowCount="0"/> -->'
      zip.file(table.name, (await table.async('string')).replaceAll('"', "'")
        .replace('<table ', comment + '<table '))
      const bytes = await zip.generateAsync({ type: 'nodebuffer' })
      const saved = await save(bytes, filterChange([{ colId: 0, values: ['12.5'] }]))
      const result = await JSZip.loadAsync(saved)
      const xml = await result.file(table.name).async('string')
      assert.ok(xml.includes(comment))
      assert.match(xml, /<autoFilter ref="A1:C2"><filterColumn colId="0">/)
      assert.doesNotMatch(await result.file(part).async('string'), /<autoFilter\b/)
      const [updated] = (await native.inspect(saved)).sheets[0].tables
      assert.equal(updated.name, 'QuotedTotals')
      assert.equal(updated.totalsRowCount, 1)
      assert.equal(updated.filterActive, true)
    },
  )

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
