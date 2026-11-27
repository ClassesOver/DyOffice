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

const worksheetPath = 'xl/worksheets/sheet1.xml'
const sheetRels = 'xl/worksheets/_rels/sheet1.xml.rels'
const drawingPath = 'xl/drawings/drawing1.xml'
const chartPath = 'xl/charts/chart1.xml'
const slicerPath = 'xl/slicers/slicer1.xml'
const timelinePath = 'xl/timelines/timeline1.xml'
const chartNs = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const art = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const sheetName = "Quarter's data"
const source = "'QUARTER''S DATA'!"
const series = (col, cache) => `
  <ser><tx><v>Series ${col}</v></tx>
    <cat><numRef><f>${source}$A$2:$A$3</f><numCache><ptCount val="1"/><pt idx="0"><v>46500</v></pt></numCache></numRef></cat>
    <val><numRef><f>${source}$${col}$2:$${col}$3</f><numCache>${cache}<ptCount val="1"/><pt idx="0"><v>5</v></pt></numCache></numRef></val>
  </ser>`

function control(name, kind, col) {
  const ns = 'http://schemas.microsoft.com/office/drawing/2010/' + kind
  const marker = (tag, col, row) =>
    `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`
  return `<xdr:twoCellAnchor>${marker('from', col, 1)}${marker('to', col + 2, 4)}
    <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="${art}" xmlns:s="${ns}">
      <mc:Choice Requires="s"><xdr:graphicFrame><a:graphic><a:graphicData uri="${ns}"><s:${kind} name="${name}"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice>
      <mc:Fallback><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="0" name="Fallback"/></xdr:nvSpPr></xdr:sp></mc:Fallback>
    </mc:AlternateContent><xdr:clientData/>
  </xdr:twoCellAnchor>`
}

test('Web XLSX reads chart axis metadata and read-only data controls', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-chart-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const native = runtime.sheetsNative
  const zip = await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)))
  const replace = async (path, update) => zip.file(path, update(await zip.file(path).async('string')))
  await replace('xl/workbook.xml', (xml) => xml.replace('name="Acceptance"', `name="${sheetName}"`))
  await replace(worksheetPath, (xml) => xml.replace(/<sheetData>.*?<\/sheetData>/s, `<sheetData>
    <row r="2"><c r="A2" s="1"><v>46500</v></c><c r="B2" s="2"><v>4500000</v></c><c r="C2" s="3"><v>0.25</v></c><c r="D2"><v>3</v></c></row>
  </sheetData>`))
  zip.file('xl/styles.xml', `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm"/><numFmt numFmtId="165" formatCode="0.0 &quot;USD&quot;"/></numFmts>
    <cellXfs count="4"><xf/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="9"/></cellXfs>
  </styleSheet>`)
  zip.file(chartPath, `<chartSpace xmlns="${chartNs}" xmlns:a="${art}"><chart><plotArea>
    <barChart><barDir val="col"/>${series('B', '<formatCode>0.0</formatCode>')}<dLbls><numFmt sourceLinked="1" formatCode="0"/><showVal val="1"/></dLbls><axId val="1"/><axId val="2"/></barChart>
    <lineChart>${series('C', '')}<axId val="3"/><axId val="4"/></lineChart>
    <catAx><axId val="1"/><axPos val="b"/><numFmt formatCode="0" sourceLinked="1"/></catAx>
    <valAx><axId val="2"/><axPos val="l"/><numFmt formatCode="0" sourceLinked="1"/>
      <dispUnits><builtInUnit val="millions"/><dispUnitsLbl/></dispUnits>
    </valAx>
    <catAx><axId val="3"/><axPos val="t"/><numFmt formatCode="0.00" sourceLinked="0"/></catAx>
    <valAx><axId val="4"/><axPos val="r"/><numFmt formatCode="0" sourceLinked="1"/>
      <dispUnits><custUnit val="0.25"/><dispUnitsLbl><tx><rich><a:p><a:r><a:t>Quarter</a:t></a:r></a:p></rich></tx></dispUnitsLbl></dispUnits>
    </valAx>
  </plotArea></chart></chartSpace>`)
  await replace(drawingPath, (xml) => xml.replace('</xdr:wsDr>', control('Week', 'slicer', 2) + control('Year', 'timeslicer', 5) + '</xdr:wsDr>'))
  await replace(sheetRels, (xml) => xml.replace('</Relationships>', `
    <Relationship Id="weeks" Type="http://schemas.microsoft.com/office/2007/relationships/slicer" Target="../slicers/slicer1.xml"/>
    <Relationship Id="years" Type="http://schemas.microsoft.com/office/2011/relationships/timeline" Target="../timelines/timeline1.xml"/>
  </Relationships>`))
  zip.file(slicerPath, '<slicers xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><slicer name="Week" caption="Week of year"/></slicers>')
  zip.file(timelinePath, '<timelines xmlns="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><timeline name="Year" caption="Order year"/></timelines>')
  await replace('[Content_Types].xml', (xml) => xml.replace('</Types>', `
    <Override PartName="/${slicerPath}" ContentType="application/vnd.ms-excel.slicer+xml"/>
    <Override PartName="/${timelinePath}" ContentType="application/vnd.ms-excel.timeline+xml"/>
  </Types>`))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const { visuals } = await native.inspect(bytes)
  const chart = visuals.find(visual => visual.kind === 'chart').chart

  await t.test('retains slicer and timeline captions and anchors without editable locators', () => {
    const controls = visuals.filter(visual => visual.kind === 'slicer')
    assert.deepEqual(controls.map(({ name, text, anchor }) => [name, text, anchor.fromColumn, anchor.toColumn]), [
      ['Week', 'Week of year', 2, 4], ['Year', 'Order year', 5, 7],
    ])
    assert.ok(controls.every(({ drawingPath, drawingIndex }) => drawingPath === undefined && drawingIndex === undefined))
    assert.equal(visuals.length, 3)
  })

  await t.test('uses both built-in and custom display units with their labels', () => {
    assert.deepEqual([chart.yAxis.displayUnit, chart.yAxis.displayUnitLabel], [1_000_000, 'Millions'])
    assert.deepEqual([chart.secondaryYAxis.displayUnit, chart.secondaryYAxis.displayUnitLabel], [0.25, 'Quarter'])
  })

  await t.test('reads source formats for linked labels and axes, using each plot series', () => {
    assert.deepEqual(chart.series.map(({ numberFormat, categoryFormat }) => [numberFormat, categoryFormat]), [
      ['0.0', 'yyyy-mm'], ['0%', 'yyyy-mm'],
    ])
    assert.equal(chart.xAxis.numFmt, 'yyyy-mm')
    assert.equal(chart.yAxis.numFmt, '0.0 "USD"')
    assert.equal(chart.secondaryYAxis.numFmt, '0%')
    assert.equal(chart.dataLabelFormat, '0.0 "USD"')
  })

  await t.test('keeps drawing and control parts byte-identical on a normal save', async () => {
    const request = sheetsSaveRequest('sheet-1', [{ row: 1, column: 3, value: 8, writeValue: true }])
    const saved = await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))
    const output = await JSZip.loadAsync(saved.bytes)
    for (const path of [sheetRels, drawingPath, chartPath, slicerPath, timelinePath]) {
      assert.deepEqual(await output.file(path).async('nodebuffer'), await zip.file(path).async('nodebuffer'), path)
    }
    assert.deepEqual((await native.inspect(saved.bytes)).visuals, visuals)
  })
})
