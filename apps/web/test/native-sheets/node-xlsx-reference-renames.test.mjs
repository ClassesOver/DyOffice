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
import {
  createEditJournal,
  recordHyperlinkEdit,
  recordSparklineAdd,
  recordSheetRename,
  toSaveHyperlinkEdits,
  toSaveSparklineAdds,
  toSaveSheetOps,
} from '../../../sheets/src/renderer/edit-journal.ts'

const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
const wbPath = 'xl/workbook.xml',
  relPath = 'xl/_rels/workbook.xml.rels',
  contentTypes = '[Content_Types].xml'
const one = 'xl/worksheets/sheet1.xml',
  two = 'xl/worksheets/sheet2.xml'
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const first = 'sheet-1',
  second = 'sheet-2'
const bounds = { startRow: 0, endRow: 4, startColumn: 0, endColumn: 7 }
const xmlPart = async (zip, path) => zip.file(path).async('string')

async function fixture({
  changeOne = (xml) => xml,
  columns = '',
  tail = '',
  changeWorkbook = (xml) => xml,
} = {}) {
  const zip = await JSZip.loadAsync(original)
  zip.file(
    wbPath,
    changeWorkbook(
      (await xmlPart(zip, wbPath)).replace(
        '</sheets>',
        '<sheet name="Other" sheetId="2" r:id="rId3"/></sheets>',
      ),
    ),
  )
  zip.file(
    relPath,
    (await xmlPart(zip, relPath)).replace(
      '</Relationships>',
      `<Relationship Id="rId3" Type="${r}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
  )
  zip.file(
    contentTypes,
    (await xmlPart(zip, contentTypes)).replace(
      '</Types>',
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
  )
  zip.file(one, changeOne(await xmlPart(zip, one)))
  zip.file(
    two,
    `<worksheet xmlns="${main}"><dimension ref="A1:E3"/><sheetData><row r="1"><c r="A1"><v>100</v></c>${columns}</row></sheetData>${tail}</worksheet>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

test(
  'Web XLSX preserves sheet references in pending edits, formulas, charts, and pivot caches',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-reference-renames-'))
    let runtime
    t.after(async () => {
      await runtime?.close()
      await rm(dir, { recursive: true, force: true })
    })
    await buildSheetsGateway(join(dir, 'gateway.mjs'))
    runtime = await configuredSheetsRuntime(
      {
        DYOFFICE_AUTH_MODE: 'local',
        DYOFFICE_SANDBOX_MODE: 'subprocess',
        DYOFFICE_DEPLOYMENT_ID: randomUUID(),
        DYOFFICE_XLSX_NODE_ENGINE: join(dir, 'xlsx-node-engine.mjs'),
        DYOFFICE_XLSX_GATEWAY_RUNNER: join(dir, 'gateway-process.mjs'),
      },
      { enabled: true },
    )
    const native = runtime.sheetsNative
    const read = (bytes, sheet) => native.readRange(bytes, sheet, bounds)
    const inspect = (bytes) => native.inspect(bytes, undefined, true)
    const save = async (bytes, sheetOps, sheetOrder, fields = {}) => {
      const request = { ...sheetsSaveRequest(first, []), sheetOps, sheetOrder, ...fields }
      return (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request)))
        .bytes
    }
    const chartPath = 'xl/charts/chart1.xml'
    const cachePath = 'xl/pivotCache/pivotCacheDefinition1.xml'
    const editPart = async (bytes, path, change) => {
      const zip = await JSZip.loadAsync(bytes)
      zip.file(path, change(await xmlPart(zip, path)))
      return zip.generateAsync({ type: 'nodebuffer' })
    }
    const readPart = async (bytes, path) => xmlPart(await JSZip.loadAsync(bytes), path)
    const chartRef = async (bytes) =>
      (await inspect(bytes)).visuals.find((v) => v.chart)?.chart.series[0].valuesRef

    await t.test(
      'keeps pending links and sparklines attached to the original sheet on a name swap',
      async () => {
        const source = await fixture({
          changeOne: (xml) =>
            xml.replace(
              '<drawing ',
              '<hyperlinks><hyperlink ref="B3" location="Acceptance!A2"/></hyperlinks><drawing ',
            ),
        })
        const journal = createEditJournal()
        recordHyperlinkEdit(journal, first, 1, 3, '#Acceptance!A2')
        recordSparklineAdd(journal, {
          id: 'new-spark',
          sheetId: first,
          type: 'line',
          cells: [{ cell: 'G2', sourceRef: 'Acceptance!$A$2:$A$3' }],
        })
        recordSheetRename(journal, first, 'Holding', 'Acceptance')
        recordSheetRename(journal, second, 'Acceptance', 'Other')
        recordSheetRename(journal, first, 'Other', 'Acceptance')
        const sparklineAdditions = toSaveSparklineAdds(journal),
          hyperlinkEdits = toSaveHyperlinkEdits(journal)
        const saved = await save(source, toSaveSheetOps(journal), [first, second], {
          hyperlinkEdits,
          sparklineAdditions,
        })
        const { hyperlinks } = await read(saved, 'Other')
        const [{ sparklines }] = (await inspect(saved)).sheets
        assert.equal(hyperlinks.find((l) => l.row === 2 && l.column === 1)?.target, '#Other!A2')
        assert.equal(hyperlinks.find((l) => l.row === 1 && l.column === 3)?.target, '#Other!A2')
        assert.deepEqual(sparklines[0].cells, [{ cell: 'G2', sourceRef: 'Other!$A$2:$A$3' }])
      },
    )

    await t.test(
      'rewrites and checks references to a sheet name containing a double quote',
      async (t) => {
        const source = await fixture({
          changeWorkbook: (xml) =>
            xml
              .replace('name="Other"', 'name="Q&quot;1"')
              .replace(
                '</definedNames>',
                '<definedName name="QuotedTotal">\'Q"1\'!$A$1</definedName></definedNames>',
              ),
          changeOne: (xml) =>
            xml.replace(
              '</row></sheetData>',
              '<c r="G3"><f>\'Q"1\'!$A$1</f><v>100</v></c></row></sheetData>',
            ),
        })
        const formula = async (bytes) =>
          (await read(bytes, 'Acceptance')).cells.find((c) => c.row === 2 && c.column === 6)
            ?.formula
        assert.equal(await formula(source), "='Q\"1'!$A$1")
        const renamed = await save(
          source,
          [{ kind: 'rename-sheet', sheetId: second, newName: 'Quarter One' }],
          [first, second],
        )
        const after = await inspect(renamed)
        assert.equal(after.sheets[1].name, 'Quarter One')
        await t.test('renames formula and defined-name references', async () => {
          assert.equal(await formula(renamed), "='Quarter One'!$A$1")
          assert.equal(
            after.definedNames.find((n) => n.name === 'QuotedTotal').formula,
            "'Quarter One'!$A$1",
          )
        })
        await t.test('blocks deletion while a formula still uses that sheet', async () => {
          await assert.rejects(
            save(source, [{ kind: 'remove-sheet', sheetId: second }], [first]),
            /Invalid workbook input/,
          )
        })
      },
    )

    await t.test(
      'rewrites and checks chart references that use an alternate namespace prefix',
      async (t) => {
        const base = await fixture()
        const extension = '<c:extLst><c:ext uri="urn:example:cache"><c:numRef><c:f>Other!B9</c:f></c:numRef></c:ext></c:extLst>'
        const aliased = (xml) => xml.replaceAll('xmlns:c=', 'xmlns:ch=').replaceAll('<c:', '<ch:').replaceAll('</c:', '</ch:')
        const canonical = await editPart(base, chartPath, (xml) =>
          xml.replace('Acceptance!$A$2:$A$3', 'Other!$A$1:$A$2'),
        )
        const alternate = await editPart(canonical, chartPath, (xml) =>
          aliased(xml.replace('</c:chartSpace>', extension + '</c:chartSpace>')),
        )
        const renames = [{ kind: 'rename-sheet', sheetId: second, newName: 'Updated' }]
        assert.equal(await chartRef(alternate), 'Other!$A$1:$A$2')
        const good = await save(canonical, renames, [first, second])
        const bad = await save(alternate, renames, [first, second])
        const actual = await chartRef(bad),
          control = await chartRef(good)
        await t.test('renames the chart series source without rewriting cached extension formulas', async () => {
          assert.equal(control, 'Updated!$A$1:$A$2')
          assert.equal(actual, control)
          assert.ok((await readPart(bad, chartPath)).includes(aliased(extension)))
        })
        await assert.rejects(
          save(canonical, [{ kind: 'remove-sheet', sheetId: second }], [first]),
          /Invalid workbook input/,
        )
        await t.test('blocks deletion while a chart still uses that sheet', async () => {
          await assert.rejects(
            save(alternate, [{ kind: 'remove-sheet', sheetId: second }], [first]),
            /Invalid workbook input/,
          )
        })
        await t.test('allows deletion when only an opaque chart extension names the sheet', async () => {
          const extensionOnly = await editPart(base, chartPath, (xml) =>
            aliased(xml.replace('</c:chartSpace>', extension + '</c:chartSpace>')),
          )
          const removed = await save(extensionOnly, [{ kind: 'remove-sheet', sheetId: second }], [first])
          assert.deepEqual((await inspect(removed)).sheets.map((sheet) => sheet.name), ['Acceptance'])
          assert.ok((await readPart(removed, chartPath)).includes(aliased(extension)))
        })
      },
    )

    await t.test('rewrites and checks single-quoted pivot cache source attributes', async (t) => {
      const base = await fixture({
        changeWorkbook: (xml) => xml.replace(/<definedNames>[\s\S]*?<\/definedNames>/, ''),
      })
      const withPivot = await save(base, [], [first, second], {
        pivotAdditions: [
          {
            sheetId: second,
            sourceSheetId: first,
            sourceArea: { startRow: 0, startColumn: 0, endRow: 3, endColumn: 1 },
            location: { startRow: 0, startColumn: 5, endRow: 5, endColumn: 6 },
            name: 'Sales',
            fieldNames: ['Region', 'Amount'],
            rowFieldIndices: [0],
            rowItems: ['East', 'West'],
            values: [{ fieldIndex: 1, agg: 'sum' }],
          },
        ],
      })
      assert.equal((await inspect(withPivot)).sheets[1].pivotTables.length, 1)
      const single = await editPart(withPivot, cachePath, (xml) =>
        xml.replace('sheet="Acceptance"', "sheet='Acceptance'"),
      )
      const target = async (bytes) =>
        (await readPart(bytes, cachePath)).match(/<worksheetSource\b[^>]*>/)?.[0]
      assert.match(await target(single), /sheet='Acceptance'/)
      const renames = [{ kind: 'rename-sheet', sheetId: first, newName: 'Source' }]
      const good = await save(withPivot, renames, [first, second])
      const bad = await save(single, renames, [first, second])
      assert.match(await target(good), /sheet="Source"/)
      await t.test('renames the cache source', async () => {
        assert.match(await target(bad), /sheet=(["'])Source\1/)
      })
      const removal = [{ kind: 'remove-sheet', sheetId: first }]
      await assert.rejects(save(withPivot, removal, [second]), /Invalid workbook input/)
      await t.test('blocks deletion while a pivot cache still uses that sheet', async () => {
        await assert.rejects(save(single, removal, [second]), /Invalid workbook input/)
      })
    })
  },
)
