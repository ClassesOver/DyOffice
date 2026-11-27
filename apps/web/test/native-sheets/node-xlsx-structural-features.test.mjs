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
const path = 'xl/worksheets/sheet1.xml'
const bounds = { startRow: 0, endRow: 5, startColumn: 0, endColumn: 8 }
const guids = {
  rule: '{A8E07728-A394-4F9A-819B-5CCA75A64015}',
  base: '{B025F937-C7B1-47D3-B67F-A62EFF666E3E}',
  cf: '{78C0D931-6437-407D-A8EE-F0AAD7539E65}',
  spark: '{05C60535-1F16-4FD2-B633-F4F36F0B64E0}',
}
const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const xm = 'http://schemas.microsoft.com/office/excel/2006/main'
const spark = `
  <ext uri="${guids.spark}" xmlns:x14="${x14}" xmlns:xm="${xm}">
    <x14:sparklineGroups><x14:sparklineGroup type="column"><x14:sparklines>
      <x14:sparkline><xm:f>Acceptance!D2:D3</xm:f><xm:sqref>G2</xm:sqref></x14:sparkline>
    </x14:sparklines></x14:sparklineGroup></x14:sparklineGroups>
  </ext>`
const foreignBarColor = '<negativeFillColor xmlns="urn:example:cf" rgb="FFFF0000"/>'
const twin = `
  <ext uri="${guids.cf}" xmlns:x14="${x14}" xmlns:xm="${xm}">
    <x14:conditionalFormattings><x14:conditionalFormatting>
      <x14:cfRule type="dataBar" id="${guids.rule}"><x14:dataBar minLength="0" maxLength="100">
        <x14:cfvo type="formula"><xm:f>Acceptance!$D$2</xm:f></x14:cfvo>
        <x14:cfvo type="max"/><x14:fillColor rgb="FF336699"/>${foreignBarColor}
      </x14:dataBar></x14:cfRule>
      <xm:sqref>E2:E3</xm:sqref>
    </x14:conditionalFormatting></x14:conditionalFormattings>
  </ext>`
const base = `
  <conditionalFormatting sqref="E2:E3"><cfRule type="dataBar" priority="1">
    <dataBar><cfvo type="formula" val="Acceptance!$D$2"/><cfvo type="max"/><color rgb="FF336699"/></dataBar>
    <extLst><ext uri="${guids.base}" xmlns:x14="${x14}"><x14:id>${guids.rule}</x14:id></ext></extLst>
  </cfRule></conditionalFormatting>`
const icon = `
  <conditionalFormatting sqref="F2:F3"><cfRule type="iconSet" priority="2">
    <iconSet iconSet="3Arrows">
      <cfvo type="min"/><cfvo type="formula" val="Acceptance!$D$2"/><cfvo type="percent" val="67"/>
    </iconSet>
  </cfRule></conditionalFormatting>`
const filter = `
  <autoFilter ref="B1:F4">
    <filterColumn colId='2'><filters><filter val="12.5"/></filters></filterColumn>
    <sortState ref="B2:F4"><sortCondition ref='D2:D4'/></sortState>
  </autoFilter>`
const ops = [
  { sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 },
  { sheetId: 'sheet-1', kind: 'insert-cols', index: 3, count: 1 },
]
const rename = [{ kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'New Tab' }]
test(
  'Web XLSX moves sparklines, formatting thresholds and filters during structural saves',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-structural-features-'))
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
    const zip = await JSZip.loadAsync(original)
    const sourceXml = (await zip.file(path).async('string'))
      .replace('<drawing ', filter + base + icon + '<drawing ')
      .replace('</worksheet>', '<extLst>' + spark + twin + '</extLst></worksheet>')
    zip.file(path, sourceXml)
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const read = (file, sheet) => native.readRange(file, sheet, bounds)
    const extractSparks = async (file) =>
      (await native.inspect(file, undefined, true)).sheets[0].sparklines.flatMap((g) => g.cells)
    const before = await read(source, 'Acceptance')
    const request = { ...sheetsSaveRequest('sheet-1', []), structuralOps: ops, sheetOps: rename }
    const saved = (
      await native.savePlan(source, await runtime.sheetsWorkbookPlanner(source, request))
    ).bytes
    const after = await read(saved, 'New Tab')
    const resultXml = await (await JSZip.loadAsync(saved)).file(path).async('string')
    await t.test('moves a sparkline and updates its renamed source', async () => {
      const old = await extractSparks(source)
      const next = await extractSparks(saved)
      assert.deepEqual(old, [{ cell: 'G2', sourceRef: 'Acceptance!D2:D3' }])
      assert.deepEqual(next, [{ cell: 'H3', sourceRef: "'New Tab'!E3:E4" }])
    })
    await t.test(
      'moves the x14 data bar range and threshold along with its legacy fallback',
      () => {
        const old = before.conditionalRules.find((r) => r.ruleType === 'dataBar')
        const next = after.conditionalRules.find((r) => r.ruleType === 'dataBar')
        const extRange = resultXml.match(
          /<xm:sqref>([^<]+)<\/xm:sqref>\s*<\/x14:conditionalFormatting>/,
        )?.[1]
        assert.equal(old.cfvos[0].value, 'Acceptance!$D$2')
        assert.deepEqual([old.minLength, old.maxLength, old.negativeColor], [0, 100, undefined])
        assert.deepEqual(next.ranges, [{ startRow: 2, startColumn: 5, endRow: 3, endColumn: 5 }])
        assert.equal(next.cfvos[0].value, "'New Tab'!$E$3")
        const legacyThreshold = resultXml.match(/<cfvo type="formula" val="([^"]+)"\/>/)?.[1]
        assert.equal(legacyThreshold, "'New Tab'!$E$3")
        assert.equal(extRange, 'F3:F4')
        assert.ok(resultXml.includes(foreignBarColor))
      },
    )
    await t.test('moves a legacy icon set formula threshold', () => {
      const old = before.conditionalRules.find((r) => r.ruleType === 'iconSet')
      const next = after.conditionalRules.find((r) => r.ruleType === 'iconSet')
      assert.equal(old.cfvos[1].value, 'Acceptance!$D$2')
      assert.deepEqual(next.ranges, [{ startRow: 2, startColumn: 6, endRow: 3, endColumn: 6 }])
      assert.equal(next.cfvos[1].value, "'New Tab'!$E$3")
    })
    await t.test(
      'keeps single-quoted filters and sort conditions attached to the shifted column',
      () => {
        const autoFilterXml = resultXml.match(/<autoFilter\b[\s\S]*?<\/autoFilter>/)?.[0]
        assert.deepEqual(before.autoFilterColumns, [{ colId: 2, values: ['12.5'] }])
        assert.deepEqual(after.autoFilter, { startRow: 1, startColumn: 1, endRow: 4, endColumn: 6 })
        assert.deepEqual(after.autoFilterColumns, [{ colId: 3, values: ['12.5'] }])
        assert.match(autoFilterXml, /<sortCondition ref=(["'])E3:E5\1\/>/)
      },
    )
    await t.test('reads, edits and shifts only SpreadsheetML merges', async () => {
      const foreign = 'xmlns="urn:example:merges"'
      const extension = `<mergeCells ${foreign} count="1"><mergeCell ref="F2:G2"/></mergeCells>`
      const foreignMerge = `<mergeCell ${foreign} ref="G2:H2"/>`
      const comment = '<!-- <mergeCell ref="A1:B1"/> -->'
      const realMerge = "<mergeCell ref='&#66;2:C2'></mergeCell>"
      const inputZip = await JSZip.loadAsync(original)
      const inputXml = await inputZip.file(path).async('string')
      inputZip.file(path, inputXml.replace('<drawing ', extension +
        `<mergeCells count="1">${foreignMerge}${comment}${realMerge}</mergeCells><drawing `))
      const input = await inputZip.generateAsync({ type: 'nodebuffer' })
      const area = (row, startColumn, endColumn) => ({ startRow: row, endRow: row, startColumn, endColumn })
      const originalArea = area(1, 1, 2)
      const addedArea = area(2, 3, 4)
      const shiftedArea = area(3, 3, 4)
      const readMerges = async (bytes) => (await read(bytes, 'Acceptance')).merges
      const save = async (bytes, ...structuralOps) => {
        const request = { ...sheetsSaveRequest('sheet-1', []), structuralOps: structuralOps.map((op) => ({ sheetId: 'sheet-1', ...op })) }
        return (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
      }
      assert.deepEqual(await readMerges(input), [originalArea])
      const added = await save(input, { kind: 'merge-cells', range: addedArea })
      assert.deepEqual(await readMerges(added), [originalArea, addedArea])
      const shifted = await save(added, { kind: 'insert-rows', index: 0, count: 1 })
      assert.deepEqual(await readMerges(shifted), [area(2, 1, 2), shiftedArea])
      const removed = await save(added, { kind: 'unmerge-cells', range: originalArea })
      assert.deepEqual(await readMerges(removed), [addedArea])
      const cleared = await save(removed, { kind: 'unmerge-cells', range: addedArea })
      assert.deepEqual(await readMerges(cleared), [])
      for (const [bytes, count] of [[added, 2], [shifted, 2], [removed, 1], [cleared, 0]]) {
        const xml = await (await JSZip.loadAsync(bytes)).file(path).async('string')
        assert.match(xml, new RegExp(`<mergeCells count="${count}">`))
        for (const preserved of [extension, foreignMerge, comment]) assert.ok(xml.includes(preserved), preserved)
      }
    })
  },
)
