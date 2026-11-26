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

const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
const wbPath = 'xl/workbook.xml',
  relPath = 'xl/_rels/workbook.xml.rels',
  contentTypes = '[Content_Types].xml'
const one = 'xl/worksheets/sheet1.xml',
  two = 'xl/worksheets/sheet2.xml'
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const xm = 'http://schemas.microsoft.com/office/excel/2006/main'
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
  'Web XLSX preserves worksheet identity across tab operations',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-tab-operations-'))
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
    const save = async (bytes, sheetOps, sheetOrder) => {
      const request = { ...sheetsSaveRequest(first, []), sheetOps, sheetOrder }
      return (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request)))
        .bytes
    }
    await t.test(
      'keeps formulas and defined names attached to the original sheets during a name swap',
      async () => {
        const source = await fixture({
          changeOne: (xml) =>
            xml.replace(
              '</row></sheetData>',
              '<c r="G3"><f>Other!A1</f><v>100</v></c></row></sheetData>',
            ),
          columns: '<c r="B1"><f>Acceptance!A2</f><v>12.5</v></c>',
        })
        const renames = [
          { kind: 'rename-sheet', sheetId: first, newName: 'Other' },
          { kind: 'rename-sheet', sheetId: second, newName: 'Acceptance' },
        ]
        assert.equal(
          (await read(source, 'Acceptance')).cells.find((c) => c.row === 2 && c.column === 6)
            ?.formula,
          '=Other!A1',
        )
        assert.equal(
          (await read(source, 'Other')).cells.find((c) => c.row === 0 && c.column === 1)?.formula,
          '=Acceptance!A2',
        )
        const saved = await save(source, renames, [first, second])
        const meta = await inspect(saved)
        const actual = {
          formerAcceptance: (await read(saved, 'Other')).cells.find(
            (c) => c.row === 2 && c.column === 6,
          )?.formula,
          formerOther: (await read(saved, 'Acceptance')).cells.find(
            (c) => c.row === 0 && c.column === 1,
          )?.formula,
          revenue: meta.definedNames.find((n) => n.name === 'Revenue')?.formula,
        }
        assert.deepEqual(
          meta.sheets.map((s) => s.name),
          ['Other', 'Acceptance'],
        )
        assert.deepEqual(actual, {
          formerAcceptance: '=Acceptance!A1',
          formerOther: '=Other!A2',
          revenue: 'Other!$A$2:$A$3',
        })
      },
    )
    await t.test(
      'preserves the implicit active tab and both quoted forms of local scope on reorder',
      async (t) => {
        const source = await fixture({
          changeWorkbook: (xml) =>
            xml.replace(
              '</definedNames>',
              `<definedName name="LocalBudget" localSheetId='0'>$A$2</definedName><definedName name="LocalControl" localSheetId="1">$A$1</definedName><definedName name="_xlnm.Print_Area" localSheetId='0'>Acceptance!$A$1:$B$3</definedName></definedNames>`,
            ),
        })
        const before = await inspect(source)
        const summary = (meta) => ({
          active: meta.sheets[meta.activeTab]?.name,
          locals: meta.definedNames
            .filter((n) => n.sheetIndex !== undefined)
            .map((n) => [n.name, meta.sheets[n.sheetIndex]?.name]),
          printOwners: meta.sheets.filter((s) => s.printArea).map((s) => s.name),
        })
        assert.deepEqual(summary(before), {
          active: 'Acceptance',
          locals: [
            ['LocalBudget', 'Acceptance'],
            ['LocalControl', 'Other'],
          ],
          printOwners: ['Acceptance'],
        })
        const saved = await save(source, [{ kind: 'reorder-sheets' }], [second, first])
        const after = await inspect(saved)
        const actual = summary(after)
        assert.deepEqual(
          after.sheets.map((s) => s.name),
          ['Other', 'Acceptance'],
        )
        await t.test('preserves the implicit active tab', () =>
          assert.equal(actual.active, 'Acceptance'),
        )
        await t.test('preserves local names and print areas on the original tabs', () => {
          assert.deepEqual(actual.locals, [
            ['LocalBudget', 'Acceptance'],
            ['LocalControl', 'Other'],
          ])
          assert.deepEqual(actual.printOwners, ['Acceptance'])
        })
      },
    )
    await t.test('preserves an explicit active tab followed by a view without an active tab', async () => {
      const secondary = '<workbookView xWindow="1200" showSheetTabs="0"/>'
      const source = await fixture({ changeWorkbook: (xml) => xml.replace('<workbookView/>',
        '<workbookView activeTab="1"/>' + secondary) })
      const before = await inspect(source)
      assert.equal(before.sheets[before.activeTab]?.name, 'Other')

      const saved = await save(source, [{ kind: 'reorder-sheets' }], [second, first])
      const after = await inspect(saved)
      assert.equal(after.sheets[after.activeTab]?.name, 'Other')
      assert.equal(after.openingViewport.result.cells[0].value, 100)
      const xml = await xmlPart(await JSZip.loadAsync(saved), wbPath)
      assert.ok(xml.includes('<workbookView activeTab="0"/>' + secondary))
    })
    await t.test('keeps the visible opening sheet when a hidden active tab is stale', async () => {
      const source = await fixture({ changeWorkbook: (xml) =>
        xml.replace('<sheet name="Acceptance"', '<sheet name="Acceptance" state="veryHidden"') })
      const before = await inspect(source)
      assert.equal(before.openingViewport.sheetId, second)

      const added = 'local-dashboard'
      const saved = await save(source, [{ kind: 'add-sheet', sheetId: added, name: 'Dashboard' }],
        [added, first, second])
      const after = await inspect(saved)
      assert.deepEqual(after.sheets.map(({ name, hidden }) => [name, hidden]),
        [['Dashboard', false], ['Acceptance', true], ['Other', false]])
      assert.equal(after.sheets[after.activeTab]?.name, 'Other')
      assert.equal(after.openingViewport.sheetId, after.sheets[after.activeTab].id)
      assert.equal(after.openingViewport.result.cells[0].value, 100)
    })
    await t.test('protects sheets referenced by surviving objects from deletion', async (t) => {
      const clearGlobal = (xml) => xml.replace(/<definedNames>[\s\S]*?<\/definedNames>/, '')
      const hyperlink = '<hyperlinks><hyperlink ref="B1" location="Acceptance!A2"/></hyperlinks>'
      const sparkline = `<ext uri="{05C60535-1F16-4FD2-B633-F4F36F0B64E0}" xmlns:x14="${x14}" xmlns:xm="${xm}"><x14:sparklineGroups><x14:sparklineGroup><x14:sparklines><x14:sparkline><xm:f>Acceptance!A2:A3</xm:f><xm:sqref>C1</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext>`
      const validation = `<ext uri="{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}" xmlns:x14="${x14}" xmlns:xm="${xm}"><x14:dataValidations count="1"><x14:dataValidation type="list"><x14:formula1><xm:f>Acceptance!$A$2:$A$3</xm:f></x14:formula1><xm:sqref>D1</xm:sqref></x14:dataValidation></x14:dataValidations></ext>`
      const remove = [{ kind: 'remove-sheet', sheetId: first }]
      for (const [label, extra] of [
        ['a cell formula', { columns: '<c r="B1"><f>Acceptance!A2</f><v>12.5</v></c>' }],
        ['an internal hyperlink', { tail: hyperlink }],
        ['a sparkline', { tail: `<extLst>${sparkline}</extLst>` }],
        ['an x14 validation', { tail: `<extLst>${validation}</extLst>` }],
      ]) {
        await t.test(label, async () => {
          const source = await fixture({ changeWorkbook: clearGlobal, ...extra })
          await assert.rejects(save(source, remove, [second]), /Invalid workbook input/)
        })
      }
      const control = await fixture({ changeWorkbook: clearGlobal })
      const saved = await save(control, remove, [second])
      assert.deepEqual(
        (await inspect(saved)).sheets.map((s) => s.name),
        ['Other'],
      )
    })
  },
)
