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
const sheet = 'xl/worksheets/sheet1.xml'
const bounds = { startRow: 0, endRow: 5, startColumn: 0, endColumn: 8 }
const insert = ['insert-rows', 'insert-cols'].map((kind) => ({
  sheetId: 'sheet-1',
  kind,
  index: 0,
  count: 1,
}))
const rename = [{ kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'New Tab' }]
async function book(change) {
  const zip = await JSZip.loadAsync(original)
  zip.file(sheet, change(await zip.file(sheet).async('string')))
  return zip.generateAsync({ type: 'nodebuffer' })
}
const beforeDrawing = (xml, payload) => xml.replace('<drawing ', payload + '<drawing ')
const area = (row, col, endRow = row, endColumn = col) => ({
  startRow: row,
  endRow,
  startColumn: col,
  endColumn,
})
test(
  'Web XLSX shifts worksheet metadata and formulas during structural saves',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-structural-metadata-'))
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
    const save = async (bytes, request) =>
      (
        await native.savePlan(
          bytes,
          await runtime.sheetsWorkbookPlanner(bytes, {
            ...sheetsSaveRequest('sheet-1', []),
            ...request,
          }),
        )
      ).bytes
    const read = (bytes, name = 'Acceptance') => native.readRange(bytes, name, bounds)
    await t.test('keeps blank typed values, decoded errors and nonstandard numbers through a save', async () => {
      const source = await book(xml => xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/,
        '<sheetData><row r="1"><c r="A1" t="b" s="1"><v> </v></c><c r="B1" t="b"><v>0</v></c>' +
        '<c r="C1" t="b"><v>true</v></c><c r="D1" t="e"><v>_x0023_REF!</v></c>' +
        '<c r="E1" t="str"><v></v></c><c r="F1" t="n"><v>0x10</v></c>' +
        '<c r="G1"><v>1e999</v></c><c r="H1"><v>_x0031_</v></c>' +
        '<c r="I1"><v>-1.25e2</v></c></row></sheetData>'))
      const expected = [null, false, true, '#REF!', '', '0x10', '1e999', '1', -125]
      assert.deepEqual((await read(source)).cells.map(({ value }) => value), expected)
      const saved = await save(source, { structuralOps: [insert[0]] })
      assert.deepEqual((await read(saved)).cells.map(({ row, value }) => [row, value]),
        expected.map(value => [1, value]))
    })

    await t.test('keeps mixed encoded and implicit addresses through a structural save', async () => {
      const encoded = await book(xml => xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/,
        '<sheetData><row r="&#51;"><c r="&#x43;3" s="1"><v>101</v></c><c><v>102</v></c></row>' +
        '<row><c><v>103</v></c></row></sheetData>'))
      const cells = async input => (await read(input)).cells
        .map(({ row, column, value }) => [row, column, value])
      assert.deepEqual(await cells(encoded), [[2, 2, 101], [2, 3, 102], [3, 0, 103]])
      const saved = await save(encoded, { structuralOps: [insert[0]] })
      assert.deepEqual(await cells(saved), [[3, 2, 101], [3, 3, 102], [4, 0, 103]])
      assert.equal((await read(saved)).cells[0].styleIndex, 1)
    })

    await t.test(
      'moves the source and target of same-sheet links and renames a quoted target',
      async () => {
        const fixture = (q) =>
          book((xml) =>
            beforeDrawing(
              xml,
              `<hyperlinks><hyperlink ref=${q}D2${q} location=${q}Acceptance!B2${q}/></hyperlinks>`,
            ),
          )
        const canonical = await fixture('"')
        assert.deepEqual((await read(canonical)).hyperlinks, [
          { row: 1, column: 3, target: '#Acceptance!B2' },
        ])
        const inserted = (await read(await save(canonical, { structuralOps: insert }))).hyperlinks
        const single = (
          await read(
            await save(await fixture("'"), { structuralOps: insert, sheetOps: rename }),
            'New Tab',
          )
        ).hyperlinks
        assert.deepEqual(inserted, [{ row: 2, column: 4, target: '#Acceptance!C3' }])
        assert.deepEqual(single, [{ row: 2, column: 4, target: "#'New Tab'!C3" }])
      },
    )
    await t.test(
      'edits and shifts only SpreadsheetML hyperlinks',
      async () => {
        const namespace = 'xmlns="urn:example:links"'
        const foreignSection = `<hyperlinks ${namespace}><hyperlink ref="D2" location="Foreign!A1"/></hyperlinks>`
        const foreignLink = `<hyperlink ${namespace} ref="F2" location="Acceptance!A1"/>`
        const input = await book((xml) => beforeDrawing(xml, foreignSection +
          `<hyperlinks>${foreignLink}<hyperlink ref='$D$2:$E$2' location="Acceptance!B2"/></hyperlinks>`))
        const links = async (bytes) => (await read(bytes)).hyperlinks
        assert.deepEqual(await links(input), [{ row: 1, column: 3, target: '#Acceptance!B2' }])
        const edited = await save(input, {
          hyperlinkEdits: [{ sheetId: 'sheet-1', row: 1, column: 3, target: '#Acceptance!C2' }],
        })
        assert.deepEqual(await links(edited), [{ row: 1, column: 3, target: '#Acceptance!C2' }])
        const moved = await save(edited, { structuralOps: insert })
        assert.deepEqual(await links(moved), [{ row: 2, column: 4, target: '#Acceptance!D3' }])
        const cleared = await save(moved, {
          hyperlinkEdits: [{ sheetId: 'sheet-1', row: 2, column: 4, target: null }],
        })
        assert.deepEqual(await links(cleared), [])
        for (const bytes of [edited, moved, cleared]) {
          const xml = await (await JSZip.loadAsync(bytes)).file(sheet).async('string')
          assert.ok(xml.includes(foreignSection))
          assert.ok(xml.includes(foreignLink))
        }
        const editedXml = await (await JSZip.loadAsync(edited)).file(sheet).async('string')
        assert.ok(editedXml.includes('<hyperlink ref="$D$2:$E$2" location="Acceptance!C2"/>'))
      },
    )
    await t.test(
      'moves an aliased x14 validation target and renames the list formula',
      async () => {
        const originalRule =
          '<dv:dataValidations xmlns:m="http://schemas.microsoft.com/office/excel/2006/main" count="1"><dv:dataValidation type="list"><dv:formula1><m:f>Acceptance!$A$2:$A$3</m:f></dv:formula1><m:sqref>E2</m:sqref></dv:dataValidation></dv:dataValidations>'
        const ext =
          '<extLst><ext uri="{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}" xmlns:dv="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">' +
          originalRule +
          '</ext></extLst>'
        const legacy =
          '<dataValidations count="1"><dataValidation type="whole" operator="greaterThan" sqref="F2"><formula1>Acceptance!$A$2</formula1></dataValidation></dataValidations>'
        const source = await book((xml) =>
          beforeDrawing(xml, legacy).replace('</worksheet>', ext + '</worksheet>'),
        )
        const before = (await read(source)).dataValidations
        assert.deepEqual(
          before.map(({ ranges, formulas }) => [ranges, formulas]),
          [
            [[area(1, 5)], ['Acceptance!$A$2']],
            [[area(1, 4)], ['Acceptance!$A$2:$A$3']],
          ],
        )
        const after = (
          await read(await save(source, { structuralOps: insert, sheetOps: rename }), 'New Tab')
        ).dataValidations.map(({ ranges, formulas }) => [ranges, formulas])
        assert.deepEqual(after, [
          [[area(2, 6)], ["'New Tab'!$B$3"]],
          [[area(2, 5)], ["'New Tab'!$B$3:$B$4"]],
        ])
      },
    )
    await t.test(
      'moves stored allow-edit ranges on a protected sheet that allows insertion',
      async () => {
        const input = await book((xml) =>
          xml.replace(
            '</sheetData>',
            '</sheetData><sheetProtection sheet="1" insertRows="0" insertColumns="0"/><protectedRanges><protectedRange name="Input cells" sqref="B2:D3 F2"/></protectedRanges>',
          ),
        )
        const before = await read(input)
        assert.equal(before.sheetProtection.protected, true)
        assert.equal(before.sheetProtection.allow.insertRows, true)
        assert.equal(before.sheetProtection.allow.insertColumns, true)
        assert.equal(before.protectedRanges[0].sqref, 'B2:D3 F2')
        const after = await read(await save(input, { structuralOps: insert }))
        const cell = after.cells.find((cell) => cell.value === 12.5)
        assert.deepEqual([cell.row, cell.column], [2, 1])
        assert.equal(after.protectedRanges[0].sqref, 'C3:E4 G3')
      },
    )
    await t.test(
      'moves the quoted conditional formatting target and formula together',
      async () => {
        const fixture = (q) =>
          book((xml) =>
            beforeDrawing(
              xml,
              `<conditionalFormatting sqref=${q}C2:C3${q}><cfRule type="expression" priority="1"><formula>$B2&gt;10</formula></cfRule></conditionalFormatting>`,
            ),
          )
        const get = async (q) => {
          const result = await read(await save(await fixture(q), { structuralOps: insert }))
          const { ranges, formulas } = result.conditionalRules[0]
          return [ranges, formulas]
        }
        const quoted = await get("'"),
          control = await get('"')
        assert.deepEqual(quoted, [[area(2, 3, 3)], ['$C3>10']])
        assert.deepEqual(control, [[area(2, 3, 3)], ['$C3>10']])
      },
    )
    await t.test(
      'moves a quoted legacy array extent along with its master and formula',
      async () => {
        const fixture = (q) =>
          book((xml) =>
            xml.replace(
              '<c r="E2" s="3"><v>1234.567</v></c>',
              `<c r="E2" s="3"><f t="array" ref=${q}E2:E3${q}>A2:A3*2</f><v>25</v></c>`,
            ),
          )
        const result = async (q) => {
          const file = await fixture(q)
          assert.equal((await read(file)).cells.find((c) => c.arrayRef).arrayRef, 'E2:E3')
          const saved = await save(file, { structuralOps: insert })
          const { row, column, formula, arrayRef } = (await read(saved)).cells.find(
            (c) => c.arrayRef,
          )
          return [row, column, formula, arrayRef]
        }
        const quoted = await result("'"),
          control = await result('"')
        assert.deepEqual(quoted, [2, 5, '=B3:B4*2', 'F3:F4'])
        assert.deepEqual(control, [2, 5, '=B3:B4*2', 'F3:F4'])
      },
    )
  },
)
