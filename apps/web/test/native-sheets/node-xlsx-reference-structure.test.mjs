import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { growPivotDefinition, recomputePivotData } from '../../../../packages/xlsx-gateway/src/domain/pivot-engine.ts'
import { buildPivotLayout } from '../../../../packages/xlsx-gateway/src/domain/pivot-layout.ts'

import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'
import {
  createEditJournal,
  recordHyperlinkEdit,
  recordSparklineAdd,
  recordSheetRename,
  recordSheetInsert,
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
const xmlPart = (zip, path) => zip.file(path).async('string')

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
  'Web XLSX keeps cross-sheet sources and pivot output aligned during structural saves',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-reference-structure-'))
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
    const editPart = async (bytes, path, change) => {
      const zip = await JSZip.loadAsync(bytes)
      zip.file(path, change(await xmlPart(zip, path)))
      return zip.generateAsync({ type: 'nodebuffer' })
    }
    const chartRef = async (bytes) =>
      (await inspect(bytes)).visuals.find((v) => v.chart)?.chart.series[0].valuesRef

    const insertOn = (sheetId) => [
      { kind: 'insert-rows', sheetId, index: 0, count: 1 },
      { kind: 'insert-cols', sheetId, index: 0, count: 1 },
    ]
    await t.test('reorders and updates sheet tabs inside a sheet list with attributes and comments', async () => {
      const comment = '<!-- worksheet list -->'
      const bytes = await fixture({ changeWorkbook: (xml) => xml
        .replace('<sheets>', '<sheets xmlns="' + main + '">' + comment)
        .replace('</sheets>', '</sheets >') })
      const saved = await save(bytes, [
        { kind: 'rename-sheet', sheetId: first, newName: 'Renamed' },
        { kind: 'set-sheet-hidden', sheetId: first, hidden: true },
      ], [second, first])
      const metadata = await inspect(saved)
      assert.deepEqual(metadata.sheets.map(({ name, hidden }) => [name, hidden]), [['Other', false], ['Renamed', true]])
      const xml = await xmlPart(await JSZip.loadAsync(saved), wbPath)
      assert.ok(xml.includes('<sheets xmlns="' + main + '">' + comment))
      assert.ok(xml.includes('</sheets >'))
    })
    await t.test('reports a signed worksheet scope before duplicating a tab', async () => {
      const bytes = await fixture({ changeWorkbook: xml => xml.replace('</definedNames>',
        "<definedName name='LocalValue' localSheetId='&#43;0'>Acceptance!$A$1</definedName></definedNames>") })
      const metadata = await inspect(bytes)
      assert.equal(metadata.sheets[0].hasScopedDefinedNames, true)
      assert.deepEqual(metadata.definedNames.find(({ name }) => name === 'LocalValue'),
        { name: 'LocalValue', formula: 'Acceptance!$A$1', sheetIndex: 0 })
    })

    await t.test('shifts hyperlink ranges and internal destinations while preserving external locations', async () => {
      const target = 'https://example.com/workbook.xlsx'
      const links = `<hyperlinks xmlns:link="${r}" xmlns:r="urn:example:extension">` +
        '<hyperlink ref="A1:B1" link:id="rId4" location="Acceptance!A1"/>' +
        '<hyperlink ref="C1" r:id="extension-id" location="Acceptance!A1"/></hyperlinks>'
      const external = `<Relationship Id="rId4" Type="${r}/hyperlink" Target="${target}" TargetMode="External"/>`
      const source = await JSZip.loadAsync(await fixture({
        changeOne: xml => xml.replace('<drawing', () => links + '<drawing'),
        tail: links,
      }))
      const oneRels = 'xl/worksheets/_rels/sheet1.xml.rels'
      source.file(oneRels, (await xmlPart(source, oneRels)).replace('</Relationships>', () => external + '</Relationships>'))
      source.file('xl/worksheets/_rels/sheet2.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        external + '</Relationships>')
      const saved = await save(await source.generateAsync({ type: 'nodebuffer' }), [], [first, second], { structuralOps: insertOn(first) })
      const zip = await JSZip.loadAsync(saved)
      const local = await xmlPart(zip, one)
      assert.ok(local.includes('<hyperlink ref="B2:C2" link:id="rId4" location="Acceptance!A1"/>'))
      assert.ok(local.includes('<hyperlink ref="D2" r:id="extension-id" location="Acceptance!B2"/>'))
      const other = await xmlPart(zip, two)
      assert.ok(other.includes('<hyperlink ref="A1:B1" link:id="rId4" location="Acceptance!A1"/>'))
      assert.ok(other.includes('<hyperlink ref="C1" r:id="extension-id" location="Acceptance!B2"/>'))
      assert.deepEqual((await read(saved, 'Acceptance')).hyperlinks, [
        { row: 1, column: 1, target }, { row: 1, column: 3, target: '#Acceptance!B2' },
      ])
    })
    await t.test('rewrites cross-sheet formulas in CDATA and preserves literal formula-shaped text', async () => {
      const literal = 'Example <f>Other!A1</f> text'
      const comment = '<!-- <f>Other!A1</f> -->'
      const source = await fixture({
        changeOne: (xml) => xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData><row r="1">
          <c r="A1" t="str"><f><![CDATA[Other!A1&"x"]]></f><v>100x</v></c>
          <c r="B1" t="inlineStr"><is>${comment}<t><![CDATA[${literal}]]></t></is></c>
        </row></sheetData>`),
      })
      const verify = async (bytes, formula) => {
        const { cells } = await read(bytes, 'Acceptance')
        assert.equal(cells.find(({ row, column }) => row === 0 && column === 0).formula, formula)
        assert.equal(cells.find(({ row, column }) => row === 0 && column === 1).value, literal)
        assert.ok((await xmlPart(await JSZip.loadAsync(bytes), one)).includes(comment))
      }
      await verify(source, '=Other!A1&"x"')
      const renamed = await save(source, [{ kind: 'rename-sheet', sheetId: second, newName: 'Renamed' }], [first, second])
      await verify(renamed, '=Renamed!A1&"x"')
      const shifted = await save(source, [], [first, second], { structuralOps: insertOn(second) })
      await verify(shifted, '=Other!B2&"x"')

      const literalOnly = await editPart(source, one, (xml) => xml.replace(/<c r="A1"[\s\S]*?<\/c>/, '<c r="A1"><v>1</v></c>'))
      const removed = await save(literalOnly, [{ kind: 'remove-sheet', sheetId: second }], [first])
      assert.deepEqual((await inspect(removed)).sheets.map(({ name }) => name), ['Acceptance'])
      assert.equal((await read(removed, 'Acceptance')).cells.find(({ column }) => column === 1).value, literal)
    })
    const quoteFormula = "'Q\"1'!$A$1"
    await t.test('shifts chart sources with an alternate namespace prefix', async () => {
      const base = await fixture()
      const canonical = await editPart(base, chartPath, (xml) =>
        xml.replace('Acceptance!$A$2:$A$3', 'Other!$A$1:$A$2'),
      )
      const alternate = await editPart(canonical, chartPath, (xml) =>
        xml.replaceAll('xmlns:c=', 'xmlns:n=').replaceAll('<c:', '<n:').replaceAll('</c:', '</n:'),
      )
      assert.equal(await chartRef(alternate), 'Other!$A$1:$A$2')
      const control = await save(canonical, [], [first, second], {
        structuralOps: insertOn(second),
      })
      const result = await save(alternate, [], [first, second], { structuralOps: insertOn(second) })
      const actual = await chartRef(result)
      const expected = await chartRef(control)
      assert.equal(expected, 'Other!$B$2:$B$3')
      assert.equal(actual, expected)
      assert.ok(
        (await read(result, 'Other')).cells.some(
          (c) => c.row === 1 && c.column === 1 && c.value === 100,
        ),
      )
    })

    await t.test(
      'shifts references to a source sheet whose name contains a double quote',
      async () => {
        const source = await fixture({
          changeWorkbook: (xml) =>
            xml
              .replace('name="Other"', 'name="Q&quot;1"')
              .replace(
                '</definedNames>',
                `<definedName name="QuotedBookRef">${quoteFormula}</definedName></definedNames>`,
              ),
          changeOne: (xml) =>
            xml.replace(
              '</row></sheetData>',
              `<c r="G3"><f>${quoteFormula}</f><v>100</v></c></row></sheetData>`,
            ),
          columns: `<c r="B1"><f>${quoteFormula}</f><v>100</v></c>`,
        })
        const result = await save(source, [], [first, second], { structuralOps: insertOn(second) })
        const own = await read(result, 'Q"1'),
          cross = await read(result, 'Acceptance')
        assert.ok(own.cells.some((c) => c.row === 1 && c.column === 1 && c.value === 100))
        const actual = {
          sameSheet: own.cells.find((c) => c.row === 1 && c.column === 2)?.formula,
          crossSheet: cross.cells.find((c) => c.row === 2 && c.column === 6)?.formula,
          defined: (await inspect(result)).definedNames.find((n) => n.name === 'QuotedBookRef')
            ?.formula,
        }
        const movedRef = quoteFormula.replace('$A$1', '$B$2')
        assert.deepEqual(actual, {
          sameSheet: '=' + movedRef,
          crossSheet: '=' + movedRef,
          defined: movedRef,
        })
      },
    )

    await t.test(
      'moves the pivot output when the host changes and the source stays put',
      async () => {
        const base = await fixture()
        const withPivot = await save(base, [], [first, second], {
          edits: [{ sheetId: second, row: 0, column: 5, writeValue: true, value: 'Pivot header' }],
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
        const before = (await inspect(withPivot)).sheets[1].pivotTables[0]
        assert.equal(before.outputRef, 'F1:G6')
        const result = await save(withPivot, [], [first, second], {
          structuralOps: insertOn(second),
        })
        const after = (await inspect(result)).sheets[1].pivotTables[0]
        const moved = (await read(result, 'Other')).cells.find((c) => c.value === 'Pivot header')
        assert.deepEqual([moved.row, moved.column], [1, 6])
        assert.equal(after.outputRef, 'G2:H7')
        assert.equal(after.firstDataRow, before.firstDataRow)
        assert.equal(after.firstDataCol, before.firstDataCol)
        assert.equal(
          await xmlPart(await JSZip.loadAsync(result), after.cachePath),
          await xmlPart(await JSZip.loadAsync(withPivot), before.cachePath),
        )

        const comment = '<!-- <location ref="G2:H7"/> -->'
        const zip = await JSZip.loadAsync(result)
        const table = await xmlPart(zip, after.path)
        zip.file(after.path, table.replace('<location ref="G2:H7"',
          `${comment}<location ref='G2:H&#55;'`))
        const relsPath = after.path.replace(/\/([^/]+)$/, '/_rels/$1.rels')
        zip.file(relsPath, (await xmlPart(zip, relsPath)).replaceAll('"', "'"))
        const refresh = {
          edits: [{ sheetId: second, row: 7, column: 7, writeValue: true, value: 100 }],
          pivotCacheRefreshPaths: [after.cachePath],
          pivotRefreshUpdates: [{ sheetId: second, cachePath: after.cachePath, newOutputRef: 'G2:H8' }],
        }
        const expanded = await save(await zip.generateAsync({ type: 'nodebuffer' }), [], [first, second], refresh)
        const expandedPivot = (await inspect(expanded)).sheets[1].pivotTables[0]
        assert.equal(expandedPivot.outputRef, 'G2:H8')
        assert.ok((await xmlPart(await JSZip.loadAsync(expanded), after.path))
          .includes(`${comment}<location ref="G2:H8"`))

        const occupied = await editPart(await zip.generateAsync({ type: 'nodebuffer' }), two, (xml) =>
          xml.replace('</sheetData>', "<row r='8'><c r='H8'><f>1+2</f></c></row></sheetData>"))
        await assert.rejects(() => save(occupied, [], [first, second], refresh), { statusCode: 400 })

        const sharedCache = await JSZip.loadAsync(result)
        const peerPath = 'xl/pivotTables/pivotTable2.xml'
        sharedCache.file(peerPath, table.replace('name="Sales"', 'name="PeerSales"')
          .replace('ref="G2:H7"', 'ref="J2:K7"'))
        sharedCache.file('xl/pivotTables/_rels/pivotTable2.xml.rels',
          await xmlPart(sharedCache, relsPath))
        const hostRelsPath = 'xl/worksheets/_rels/sheet2.xml.rels'
        const hostRels = await xmlPart(sharedCache, hostRelsPath)
        sharedCache.file(hostRelsPath, hostRels.replace('</Relationships>',
          `<Relationship Id="rId90" Type="${r}/pivotTable" Target="../pivotTables/pivotTable2.xml"/></Relationships>`))
        const types = await xmlPart(sharedCache, contentTypes)
        sharedCache.file(contentTypes, types.replace('</Types>',
          `<Override PartName="/${peerPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/></Types>`))
        const both = await save(await sharedCache.generateAsync({ type: 'nodebuffer' }), [], [first, second], {
          pivotCacheRefreshPaths: [after.cachePath],
          pivotRefreshUpdates: [
            { sheetId: second, cachePath: after.cachePath, pivotPath: peerPath, newOutputRef: 'J2:K9' },
            { sheetId: second, cachePath: after.cachePath, pivotPath: after.path, newOutputRef: 'G2:H8' },
          ],
        })
        const pivots = (await inspect(both)).sheets[1].pivotTables
        assert.equal(pivots.find((pivot) => pivot.path === after.path)?.outputRef, 'G2:H8')
        assert.equal(pivots.find((pivot) => pivot.path === peerPath)?.outputRef, 'J2:K9')

        const edited = await save(both, [], [first, second], {
          pivotCacheRefreshPaths: [after.cachePath],
          pivotRefreshUpdates: [{
            sheetId: second, cachePath: after.cachePath, pivotPath: after.path, newOutputRef: 'G2:H8',
            relayout: {
              sheetId: second, sourceSheetId: first,
              sourceArea: { startRow: 0, startColumn: 0, endRow: 3, endColumn: 1 },
              location: { startRow: 1, startColumn: 6, endRow: 7, endColumn: 7 },
              name: 'LayoutEdit', fieldNames: ['Region', 'Amount'], rowFieldIndices: [0],
              rowItems: ['East', 'West'], values: [{ fieldIndex: 1, agg: 'count' }],
            },
          }],
        })
        const rebuilt = (await inspect(edited)).sheets[1].pivotTables
        const changed = rebuilt.find((pivot) => pivot.path === after.path)
        const unchanged = rebuilt.find((pivot) => pivot.path === peerPath)
        assert.equal(unchanged.cachePath, after.cachePath)
        assert.notEqual(changed.cachePath, after.cachePath)
        const editedZip = await JSZip.loadAsync(edited)
        assert.match(await xmlPart(editedZip, changed.path), /subtotal="count"/)
        assert.match(await xmlPart(editedZip, changed.cachePath), /refreshOnLoad="1"/)
        assert.equal(await xmlPart(editedZip, peerPath), await xmlPart(await JSZip.loadAsync(both), peerPath))
        const records = 'xl/pivotCache/pivotCacheRecords1.xml'
        assert.equal(await xmlPart(editedZip, records), await xmlPart(sharedCache, records))

        const decoy = '<!-- <pivotCaches><pivotCache cacheId="900"/></pivotCaches> -->'
        const existing = await editPart(withPivot, wbPath, (xml) =>
          xml.replace('<pivotCaches>', `${decoy}<pivotCaches>`).replace('cacheId="1"', "cacheId='&#49;'"))
        const withSecond = await save(existing, [], [first, second], {
          pivotAdditions: [{
            sheetId: second, sourceSheetId: first,
            sourceArea: { startRow: 0, startColumn: 0, endRow: 3, endColumn: 1 },
            location: { startRow: 0, startColumn: 9, endRow: 5, endColumn: 10 },
            name: 'SecondSales', fieldNames: ['Region', 'Amount'], rowFieldIndices: [0],
            rowItems: ['East', 'West'], values: [{ fieldIndex: 1, agg: 'sum' }],
            filters: [{ kind: 'label', field: 0, op: 'contains', value: 'Part?*~' }],
          }],
        })
        const registered = await inspect(withSecond)
        assert.deepEqual(registered.sheets[1].pivotTables.map((pivot) => pivot.outputRef).sort(),
          ['F1:G6', 'J1:K6'])
        const secondPivot = registered.sheets[1].pivotTables.find((pivot) => pivot.outputRef === 'J1:K6')
        const secondTable = await xmlPart(await JSZip.loadAsync(withSecond), secondPivot.path)
        assert.match(secondTable, /<customFilter val="\*Part~\?~\*~~\*"\/>/)
        const secondDefinition = await runtime.sheetsPackageReader(withSecond, undefined, {
          path: secondPivot.path, cachePath: secondPivot.cachePath,
        })
        assert.deepEqual(secondDefinition.filters, [{ kind: 'label', field: 0, op: 'contains', value: 'Part?*~' }])
        const workbook = await xmlPart(await JSZip.loadAsync(withSecond), wbPath)
        assert.ok(workbook.includes(decoy))
        assert.match(workbook, /<pivotCaches><pivotCache cacheId='&#49;'[^>]*\/><pivotCache cacheId="2"[^>]*\/><\/pivotCaches>/)

        const imported = await editPart(edited, changed.path, (xml) => xml
          .replace('<location ref="G2:H8"', '<!-- <location ref="A1:A2"/> --><location ref=\'G&#50;:H8\'')
          .replace('subtotal="count"', "subtotal='count'")
          .replace('fld="1"', "fld='1'"))
        const reopened = await runtime.sheetsPackageReader(imported, undefined, {
          path: changed.path, cachePath: changed.cachePath,
        })
        assert.equal(reopened.outputRef, 'G2:H8')
        assert.equal(reopened.dataFields[0].field, 1)
        assert.equal(reopened.dataFields[0].subtotal, 'count')
        assert.deepEqual(reopened.unsupported, [])
        const percentFilter = await editPart(imported, changed.path, (xml) =>
          xml.replace('</pivotTableDefinition>', '<filters><filter fld="0" iMeasureFld="0" type="count">' +
            '<autoFilter ref="A1"><filterColumn colId="0"><top10 percent="true" val="10"/>' +
            '</filterColumn></autoFilter></filter></filters></pivotTableDefinition>'))
        const percentDefinition = await runtime.sheetsPackageReader(percentFilter, undefined, {
          path: changed.path, cachePath: changed.cachePath,
        })
        assert.deepEqual(percentDefinition.filters, [])
        assert.match(percentDefinition.unsupported.join(), /does not support recompute/)
      },
    )

    await t.test('keeps a pivot cache attached to a renamed source table', async () => {
      const area = { startRow: 0, startColumn: 0, endRow: 2, endColumn: 1 }
      const grid = [['Region', 'Amount'], ['East', 100], ['West', 50], ['East', 50], ['Total', 200]]
      const rows = grid.map(([region, amount], index) => {
        const row = index + 1
        const value = typeof amount === 'number' ? `<v>${amount}</v>` : `<is><t>${amount}</t></is>`
        return `<row r="${row}"><c r="A${row}" t="inlineStr"><is><t>${region}</t></is></c>` +
          `<c r="B${row}"${typeof amount === 'string' ? ' t="inlineStr"' : ''}>${value}</c></row>`
      }).join('')
      const base = await fixture({ changeOne: xml => xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/,
        `<sheetData>${rows}</sheetData>`) })
      const withPivot = await save(base, [], [first, second], {
        tableAdditions: [{ sheetId: first, name: 'SourceData', area,
          columnNames: ['Region', 'Amount'], bandedRows: true }],
        pivotAdditions: [{ sheetId: second, sourceSheetId: first, sourceArea: area,
          location: { startRow: 0, startColumn: 5, endRow: 3, endColumn: 6 },
          name: 'Sales', fieldNames: ['Region', 'Amount'], rowFieldIndices: [0],
          rowItems: ['East', 'West'], values: [{ fieldIndex: 1, agg: 'sum' }] }],
      })
      const before = (await inspect(withPivot)).sheets[1].pivotTables[0]
      const hiddenMember = await editPart(withPivot, before.path, (xml) => xml
        .replace('<item x="0"/><item x="1"/><item t="default"/>',
          '<item x="0" t="data" h="true"/><item t="default"/><item x="1" t="data"/>')
        .replace('<rowItems count="3"><i><x/></i><i><x v="1"/></i>',
          '<rowItems count="2"><i><x v="2"/></i>')
        .replace('</pivotTableDefinition>',
          '<filters><filter fld="0" type="captionContains" stringValue1="t"/></filters></pivotTableDefinition>'))
      const filteredPivot = await runtime.sheetsPackageReader(hiddenMember, undefined, {
        path: before.path, cachePath: before.cachePath,
      })
      assert.deepEqual(filteredPivot.fieldItems[0].map(({ x, hidden }) => [x, hidden]),
        [[0, true], [null, false], [1, false]])
      const dataRows = grid.slice(0, 4)
      const refreshedLayout = growPivotDefinition(filteredPivot, dataRows)
      assert.equal(refreshedLayout.grown, false)
      assert.deepEqual(recomputePivotData(refreshedLayout.definition, dataRows).data, [[50], [50]])

      const rankedGrid = [
        ['Region', 'Amount', 'Page'], ['001', -10, true],
        ['1', 100, false], ['1', -20, true], ['2', 'unavailable', true],
        ['1/1/2024', 5, false],
      ]
      const rankedRows = rankedGrid.map((line, index) => {
        const row = index + 1
        const cells = line.map((value, column) => {
          const cell = `${'ABC'[column]}${row}`
          if (cell === 'A2') return "<c r='A2' t='inlineStr'><is><r><t>0</t></r><r><t>01</t></r></is></c>"
          if (cell === 'B2') return "<c r='B2'><v><![CDATA[-10]]></v></c>"
          if (cell === 'A6') return '<c r="A6" s="1"><v>45292</v></c>'
          if (typeof value === 'boolean') return `<c r="${cell}" t="b"><v>${Number(value)}</v></c>`
          return typeof value === 'number'
            ? `<c r="${cell}"><v>${value}</v></c>`
            : `<c r="${cell}" t="inlineStr"><is><t>${value}</t></is></c>`
        }).join('')
        return `<row r="${row}">${cells}</row>`
      }).join('')
      const rankedSource = await editPart(base, one, (xml) =>
        xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/,
          `<sheetData><!-- <c r="B2"><v>999</v></c> -->${rankedRows}</sheetData>`))
      const ranked = buildPivotLayout(rankedGrid, {
        rowFields: 'Region', pageFields: [{ field: 'Page', item: 'true' }],
        values: [{ field: 'Amount', agg: 'sum' }],
        filters: [{ kind: 'value', field: 'Region', valueIndex: 0, op: 'top', count: 1 }],
      })
      assert.deepEqual(ranked.matrix.slice(1), [['001', -10], ['Grand Total', -10]])
      const rankedWorkbook = await save(rankedSource, [], [first, second], {
        pivotAdditions: [{
          ...ranked.definition, sheetId: second, sourceSheetId: first, name: 'RankedSales',
          sourceArea: { startRow: 0, startColumn: 0, endRow: 5, endColumn: 2 },
          location: { startRow: 2, startColumn: 5, endRow: 4, endColumn: 6 },
        }],
      })
      const savedRank = (await inspect(rankedWorkbook)).sheets[1].pivotTables[0]
      const rankedRecords = await xmlPart(await JSZip.loadAsync(rankedWorkbook), 'xl/pivotCache/pivotCacheRecords1.xml')
      assert.match(rankedRecords, /<r><x v="0"\/><n v="-10"\/><x v="0"\/><\/r>/)
      assert.match(rankedRecords, /<r><x v="1"\/><n v="100"\/><x v="1"\/><\/r>/)
      assert.match(rankedRecords, /<r><x v="3"\/><n v="5"\/><x v="1"\/><\/r>/)
      const restoredRank = await runtime.sheetsPackageReader(rankedWorkbook, undefined, {
        path: savedRank.path, cachePath: savedRank.cachePath,
      })
      const refreshedRank = growPivotDefinition(restoredRank, rankedGrid)
      assert.equal(refreshedRank.grown, false)
      assert.deepEqual(restoredRank.fields[0].sharedItems, ['001', '1', '2', '1/1/2024'])
      assert.deepEqual(recomputePivotData(refreshedRank.definition, rankedGrid).data, [[-10], [-10]])
      const comment = '<!-- <worksheetSource name="SourceData"/> -->'
      const source = await editPart(withPivot, before.cachePath, (xml) => xml.replace(
        /<worksheetSource\b[^>]*\/>/, `${comment}<worksheetSource name='SourceData'/>`,
      ))
      await assert.rejects(() => save(source, [], [first, second], {
        structuralOps: insertOn(first),
      }), { statusCode: 400 })
      const saved = await save(source, [], [first, second], {
        tableEdits: [{ sheetId: first, tableName: 'SourceData', name: 'SalesData',
          area: { ...area, endRow: 4 }, totalsRow: true }],
      })
      const metadata = await inspect(saved)
      assert.equal(metadata.sheets[0].tables[0].name, 'SalesData')
      const after = metadata.sheets[1].pivotTables[0]
      assert.equal(after.cachePath, before.cachePath)
      assert.equal(after.outputRef, before.outputRef)
      const cache = await xmlPart(await JSZip.loadAsync(saved), after.cachePath)
      assert.ok(cache.includes(`${comment}<worksheetSource name="SalesData"/>`))
      const definition = await runtime.sheetsPackageReader(saved, undefined, {
        path: after.path, cachePath: after.cachePath,
      })
      assert.equal(definition.sourceSheet, 'Acceptance')
      assert.equal(definition.sourceRef, 'A1:B4')
      assert.deepEqual(definition.unsupported, [])
      const sourceRange = await native.readRange(saved, definition.sourceSheet,
        { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 })
      const values = Array.from({ length: 4 }, () => [null, null])
      for (const cell of sourceRange.cells) values[cell.row][cell.column] = cell.value
      const { data } = recomputePivotData(definition, values)
      assert.deepEqual(data, [[150], [50], [200]])

      const relayoutSource = await editPart(saved, after.cachePath, (xml) => xml.replace(
        'r:id="rId1"',
        'xmlns:link="http://schemas.openxmlformats.org/officeDocument/2006/relationships" link:id=\'rId&#49;\'',
      ))
      const relaid = await save(relayoutSource, [], [first, second], {
        pivotCacheRefreshPaths: [after.cachePath],
        pivotRefreshUpdates: [{
          sheetId: second, cachePath: after.cachePath, newOutputRef: after.outputRef,
          relayout: { sheetId: second, sourceSheetId: first, sourceArea: { ...area, endRow: 3 },
            location: { startRow: 0, startColumn: 5, endRow: 3, endColumn: 6 },
            name: 'LayoutEdit', fieldNames: ['Region', 'Amount'], rowFieldIndices: [0],
            rowItems: ['West', 'East'], values: [{ fieldIndex: 1, agg: 'sum' }] },
        }],
      })
      const relaidZip = await JSZip.loadAsync(relaid)
      assert.match(await xmlPart(relaidZip, after.cachePath), /r:id="rId1"/)
      assert.match(await xmlPart(relaidZip, 'xl/pivotCache/pivotCacheRecords1.xml'), /count="0"/)
      const relaidDefinition = await runtime.sheetsPackageReader(relaid, undefined, {
        path: after.path, cachePath: after.cachePath,
      })
      assert.equal(relaidDefinition.sourceRef, 'A1:B4')
      assert.deepEqual(relaidDefinition.unsupported, [])

      const converted = await save(saved, [], [first, second], {
        tableEdits: [{ sheetId: first, tableName: 'SalesData', remove: true }],
      })
      assert.deepEqual((await inspect(converted)).sheets[0].tables, [])
      const convertedCache = await xmlPart(await JSZip.loadAsync(converted), after.cachePath)
      assert.match(convertedCache, /<worksheetSource[^>]*ref="A1:B4"[^>]*\/>/)
      assert.ok(convertedCache.includes(comment))
      const convertedDefinition = await runtime.sheetsPackageReader(converted, undefined, {
        path: after.path, cachePath: after.cachePath,
      })
      assert.equal(convertedDefinition.sourceSheet, 'Acceptance')
      const convertedRange = await native.readRange(converted, convertedDefinition.sourceSheet,
        { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 })
      assert.deepEqual(convertedRange.cells, sourceRange.cells)
      assert.deepEqual(recomputePivotData(convertedDefinition, values).data, data)

      const fakeRoot = '<!-- <pivotCacheDefinition refreshOnLoad="0"/> -->'
      const pendingRefresh = await editPart(converted, after.cachePath, (xml) => xml
        .replace('<pivotCacheDefinition ', `${fakeRoot}<p:pivotCacheDefinition xmlns:p="${main}" refreshOnLoad='0' `)
        .replace('</pivotCacheDefinition>', '</p:pivotCacheDefinition>'))
      const refreshed = await save(pendingRefresh, [], [first, second], { pivotCacheRefreshPaths: [after.cachePath] })
      const refreshedCache = await xmlPart(await JSZip.loadAsync(refreshed), after.cachePath)
      assert.ok(refreshedCache.includes(fakeRoot))
      assert.match(refreshedCache.slice(refreshedCache.indexOf(fakeRoot) + fakeRoot.length),
        /^<(?:p:)?pivotCacheDefinition\b[^>]*\brefreshOnLoad="1"/)
      const refreshedDefinition = await runtime.sheetsPackageReader(refreshed, undefined, {
        path: after.path, cachePath: after.cachePath,
      })
      assert.equal(refreshedDefinition.sourceRef, 'A1:B4')

      const named = await editPart(saved, wbPath, (xml) => xml.replace('</definedNames>',
        '<definedName name="RegionInput">Other!$A$1:$B$3</definedName>' +
        '<definedName name="RegionInput" localSheetId="0">\'Acceptance\'!$A$1:$B$4</definedName>' +
        '<definedName name="DynamicInput">OFFSET(Acceptance!$A$1,0,0,4,2)</definedName></definedNames>'))
      const readNamed = async (attributes) => {
        const bytes = await editPart(named, after.cachePath, (xml) =>
          xml.replace('<worksheetSource name="SalesData"/>', `<worksheetSource ${attributes}/>`))
        return runtime.sheetsPackageReader(bytes, undefined, { path: after.path, cachePath: after.cachePath })
      }
      const global = await readNamed('name="regioninput"')
      assert.equal(global.sourceSheet, 'Other')
      assert.equal(global.sourceRef, 'A1:B3')
      assert.deepEqual(global.unsupported, [])
      const local = await readNamed('name="RegionInput" sheet="Acceptance"')
      assert.equal(local.sourceSheet, 'Acceptance')
      assert.equal(local.sourceRef, 'A1:B4')
      assert.deepEqual(recomputePivotData(local, values).data, [[150], [50], [200]])
      assert.ok((await readNamed('name="DynamicInput"')).unsupported.length > 0)
    })

    await t.test('preserves pending references to a new tab that takes an old name', async () => {
      const base = await save(await fixture(), [], [first, second], {
        hyperlinkEdits: [{ sheetId: second, row: 0, column: 4, target: '#Acceptance!A2' }],
        sparklineAdditions: [
          {
            sheetId: second,
            type: 'line',
            cells: [{ cell: 'D1', sourceRef: 'Acceptance!$A$2:$A$3' }],
          },
        ],
      })
      const journal = createEditJournal()
      const fresh = 'new-acceptance'
      recordSheetRename(journal, first, 'Archived', 'Acceptance')
      recordSheetInsert(journal, fresh, 'Acceptance')
      recordHyperlinkEdit(journal, second, 0, 1, '#Acceptance!A2')
      recordSparklineAdd(journal, {
        id: 'fresh-source',
        sheetId: second,
        type: 'column',
        cells: [{ cell: 'C1', sourceRef: 'Acceptance!$A$2:$A$3' }],
      })
      const hyperlinkEdits = toSaveHyperlinkEdits(journal),
        sparklineAdditions = toSaveSparklineAdds(journal)
      const result = await save(base, toSaveSheetOps(journal), [first, second, fresh], {
        hyperlinkEdits,
        sparklineAdditions,
      })
      const metadata = await inspect(result)
      assert.deepEqual(
        metadata.sheets.map((s) => s.name),
        ['Archived', 'Other', 'Acceptance'],
      )
      const links = (await read(result, 'Other')).hyperlinks
      assert.equal(links.find((link) => link.column === 1)?.target, '#Acceptance!A2')
      assert.equal(links.find((link) => link.column === 4)?.target, '#Archived!A2')
      const sparklines = metadata.sheets[1].sparklines.flatMap((group) => group.cells)
      assert.equal(sparklines.find((cell) => cell.cell === 'C1')?.sourceRef, 'Acceptance!$A$2:$A$3')
      assert.equal(sparklines.find((cell) => cell.cell === 'D1')?.sourceRef, 'Archived!$A$2:$A$3')
      assert.ok(
        (await read(result, 'Archived')).cells.some(
          (c) => c.row === 1 && c.column === 0 && c.value === 12.5,
        ),
      )
      assert.ok(
        !(await read(result, 'Acceptance')).cells.some(
          (c) => c.row === 1 && c.column === 0 && c.value === 12.5,
        ),
      )
    })
  },
)
