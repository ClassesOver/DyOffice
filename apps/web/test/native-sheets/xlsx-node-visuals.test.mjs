import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { workbookFileSchema } from '../../../sheets/src/shared/desktop-api.ts'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { readWorkbookVisuals } from '../../server/sheets/xlsx-node-visuals.ts'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

const fixture = new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)
const nativeReplay = new URL('../fixtures/sheets/assistant-replay.json', import.meta.url)
const sourceSheet = [{ id: 'sheet-1', name: 'Acceptance' }]
const textOf = zip => async path => await zip.file(path)?.async('string') ?? ''
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const drawingPath = 'xl/drawings/drawing1.xml'
const drawingRels = 'xl/drawings/_rels/drawing1.xml.rels'
const chartPath = 'xl/charts/chart1.xml'
const mainNs = 'http://schemas.openxmlformats.org/drawingml/2006/main'

async function appendDrawing(zip, markup) {
  const source = await textOf(zip)(drawingPath)
  zip.file(drawingPath, (source.includes('xmlns:a=') ? source : source.replace('<xdr:wsDr ', `<xdr:wsDr xmlns:a="${mainNs}" `))
    .replace('</xdr:wsDr>', markup + '</xdr:wsDr>'))
}

test('imports the acceptance chart with a usable anchor, series cache, and editable source reference', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const [visual, ...rest] = await readWorkbookVisuals(textOf(zip), sourceSheet)
  assert.equal(rest.length, 0)
  assert.deepEqual({ id: visual.id, sheetId: visual.sheetId, name: visual.name, kind: visual.kind },
    { id: 'visual-1', sheetId: 'sheet-1', name: 'Revenue chart', kind: 'chart' })
  assert.deepEqual(visual.anchor, {
    fromRow: 5, fromColumn: 0, fromRowOffset: 0, fromColumnOffset: 0,
    toRow: 20, toColumn: 6, toRowOffset: 0, toColumnOffset: 0, explicitTo: true,
  })
  assert.equal(visual.drawingPath, drawingPath)
  assert.equal(visual.drawingIndex, 0)
  assert.equal(visual.chartPath, chartPath)
  assert.deepEqual(visual.chart.chartTypes, ['barChart'])
  assert.equal(visual.chart.grouping, 'clustered')
  assert.equal(visual.chart.legend, 'none')
  assert.deepEqual(visual.chart.series.map(({ name, plot, values, valuesRef }) => ({ name, plot, values, valuesRef })),
    [{ name: 'Revenue', plot: 'barChart', values: [12.5, 7.5], valuesRef: 'Acceptance!$A$2:$A$3' }])
  const native = JSON.parse(await readFile(nativeReplay, 'utf8'))
  assert.deepEqual(JSON.parse(JSON.stringify(visual)), native.meta.visuals[0])
})

test('loads combo series and secondary scale without losing sparse cache slots or uncached formulas', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const theme = ['#FFFFFF', '#000000', '#EEEEEE', '#111111', '#4472C4', '#ED7D31']
  zip.file(chartPath, `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><chart>
    <title><tx><rich><a:p><a:r><a:t>Revenue &amp; Margin</a:t></a:r></a:p></rich></tx></title>
    <plotArea><lineChart><ser><idx val="1"/><tx><strRef><f>Acceptance!B1</f></strRef></tx><cat><strRef><f>Acceptance!C2:C4</f><strCache><ptCount val="3"/><pt idx="2"><v>Dec</v></pt><pt idx="0"><v>Oct</v></pt></strCache></strRef></cat><val><numRef><f>Acceptance!B2:B4</f></numRef></val></ser><axId val="3"/><axId val="4"/></lineChart>
    <barChart><barDir val="col"/><ser><idx val="0"/><tx><v>Revenue</v></tx><val><numLit><formatCode>0.0</formatCode><ptCount val="3"/><pt idx="2"><v>-7.5</v></pt><pt idx="0"><v>12.5</v></pt></numLit></val></ser><axId val="1"/><axId val="2"/></barChart>
    <catAx><axId val="1"/><axPos val="b"/></catAx><valAx><axId val="2"/><axPos val="l"/><majorGridlines/></valAx>
    <catAx><axId val="3"/><axPos val="t"/><delete val="1"/></catAx><valAx><axId val="4"/><axPos val="r"/><scaling><min val="-1"/><max val="1"/></scaling><numFmt formatCode="0%"/></valAx></plotArea>
    <legend><legendPos val="b"/></legend><dispBlanksAs val="gap"/>
  </chart></chartSpace>`)
  const [{ chart }] = await readWorkbookVisuals(textOf(zip), sourceSheet, theme)
  assert.equal(chart.title, 'Revenue & Margin')
  assert.equal(chart.legend, 'bottom')
  assert.equal(chart.gridlines, true)
  assert.equal(chart.dispBlanksAs, 'gap')
  assert.deepEqual(chart.chartTypes, ['barChart', 'lineChart'])
  assert.deepEqual(chart.series.map(({ name, plot, color }) => [name, plot, color]),
    [['Series1', 'lineChart', '#ED7D31'], ['Revenue', 'barChart', '#4472C4']])
  assert.deepEqual(chart.series[0].categories, ['Oct', '', 'Dec'])
  assert.deepEqual(chart.series[0].values, [])
  assert.equal(chart.series[0].nameRef, 'Acceptance!B1')
  assert.equal(chart.series[0].categoriesRef, 'Acceptance!C2:C4')
  assert.equal(chart.series[0].valuesRef, 'Acceptance!B2:B4')
  assert.deepEqual(chart.series[1].values, [12.5, 0, -7.5])
  assert.deepEqual(chart.series[1].blanks, [1])
  assert.equal(chart.series[1].numberFormat, '0.0')
  assert.equal(chart.secondaryYAxis.position, 'r')
  assert.equal(chart.secondaryYAxis.numFmt, '0%')
  assert.equal(chart.secondaryYAxis.min, -1)
  assert.equal(chart.secondaryYAxis.max, 1)
})

function chartWithCategoryLevels(inner, outer) {
  return `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea>
    <c:barChart><c:barDir val="col"/><c:ser><c:tx><c:v>Revenue</c:v></c:tx>
      <c:cat><c:multiLvlStrRef><c:f>Acceptance!A1:B4</c:f><c:multiLvlStrCache><c:ptCount val="4"/>
        <c:lvl>${inner}</c:lvl><c:lvl>${outer}</c:lvl><c:lvl><c:pt idx="0"><c:v>All regions</c:v></c:pt></c:lvl>
      </c:multiLvlStrCache></c:multiLvlStrRef></c:cat>
      <c:val><c:numLit><c:ptCount val="4"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>3</c:v></c:pt><c:pt idx="3"><c:v>4</c:v></c:pt></c:numLit></c:val>
    </c:ser></c:barChart>
  </c:plotArea></c:chart></c:chartSpace>`
}

test('opens sparse multi-level category bands and keeps them after a chart title edit', { timeout: 120_000 }, async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  zip.file(chartPath, chartWithCategoryLevels(
    '<c:pt idx="3"><c:v>Apr</c:v></c:pt><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="2"><c:v>Mar</c:v></c:pt>',
    '<c:pt idx="2"><c:v>South &amp; West</c:v></c:pt><c:pt idx="0"><c:v>North</c:v></c:pt>',
  ))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-native-chart-levels-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const inspect = async input => workbookFileSchema.shape.visuals.parse((await runtime.sheetsNative.inspect(input)).visuals)[0].chart
  const chart = await inspect(bytes)
  const [series] = chart.series
  assert.equal(series.categoriesRef, 'Acceptance!A1:B4')
  assert.deepEqual(series.categories, ['Jan', '', 'Mar', 'Apr'])
  assert.deepEqual(series.values, [1, 0, 3, 4])
  assert.deepEqual(series.blanks, [1])
  assert.deepEqual(series.categoryGroups, [
    { label: 'North', start: 0, end: 2 }, { label: 'South & West', start: 2, end: 4 },
  ])

  const request = sheetsSaveRequest('sheet-1', [])
  request.chartEdits = [{ chartPath, title: 'Regional revenue' }]
  const plan = await runtime.sheetsWorkbookPlanner(bytes, request)
  const saved = (await runtime.sheetsNative.savePlan(bytes, plan)).bytes
  const reopened = await inspect(saved)
  assert.equal(reopened.title, 'Regional revenue')
  assert.deepEqual(reopened.series, chart.series)
})

test('remaps compacted category bands and omits bands with ambiguous members', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const outer = '<c:pt idx="0"><c:v>North</c:v></c:pt><c:pt idx="2"><c:v>South</c:v></c:pt>'
  const north = '<c:pt><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt>'
  const south = '<c:pt idx="3"><c:v>Apr</c:v></c:pt>'
  async function series(inner, groups) {
    zip.file(chartPath, chartWithCategoryLevels(inner, groups))
    const [{ chart }] = await readWorkbookVisuals(textOf(zip), sourceSheet)
    return chart.series[0]
  }
  const compacted = await series(north + south, outer)
  assert.deepEqual(compacted.categories, ['Jan', 'Feb', 'Apr'])
  assert.deepEqual(compacted.categoryGroups, [
    { label: 'North', start: 0, end: 2 }, { label: 'South', start: 2, end: 3 },
  ])
  const interleaved = await series(south + '<c:pt><c:v>Feb</c:v></c:pt><c:pt idx="2"><c:v>Mar</c:v></c:pt>', outer)
  assert.deepEqual(interleaved.categories, ['Apr', 'Feb', 'Mar'])
  assert.equal(interleaved.categoryGroups, undefined)
  assert.equal((await series(north + south, outer.replace(' idx="2"', ''))).categoryGroups, undefined)
})

test('keeps scatter X and Y caches separate and exposes their distinct axis bounds', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  zip.file(chartPath, `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea>
    <c:scatterChart><c:scatterStyle val="lineMarker"/><c:ser><c:tx><c:v>Observations</c:v></c:tx>
      <c:xVal><c:numRef><c:f>'Data Sheet'!$C$2:$C$3</c:f><c:numCache><c:formatCode>0.00</c:formatCode><c:pt idx="0"><c:v>0.1</c:v></c:pt><c:pt idx="1"><c:v>7.2</c:v></c:pt></c:numCache></c:numRef></c:xVal>
      <c:yVal><c:numRef><c:f>'Data Sheet'!$D$2:$D$3</c:f><c:numCache><c:pt idx="0"><c:v>20</c:v></c:pt><c:pt idx="1"><c:v>40</c:v></c:pt></c:numCache></c:numRef></c:yVal>
    </c:ser><c:axId val="1"/><c:axId val="2"/></c:scatterChart>
    <c:valAx><c:axId val="1"/><c:axPos val="b"/><c:scaling><c:min val="0"/><c:max val="9"/></c:scaling></c:valAx>
    <c:valAx><c:axId val="2"/><c:axPos val="l"/><c:scaling><c:min val="10"/><c:max val="50"/></c:scaling></c:valAx>
    </c:plotArea></c:chart></c:chartSpace>`)
  const [{ chart }] = await readWorkbookVisuals(textOf(zip), sourceSheet)
  assert.deepEqual(chart.chartTypes, ['scatterChart'])
  assert.equal(chart.scatterStyle, 'lineMarker')
  assert.deepEqual(chart.series[0].categories, ['0.1', '7.2'])
  assert.deepEqual(chart.series[0].values, [20, 40])
  assert.equal(chart.series[0].categoriesRef, "'Data Sheet'!$C$2:$C$3")
  assert.equal(chart.series[0].valuesRef, "'Data Sheet'!$D$2:$D$3")
  assert.equal(chart.series[0].categoryFormat, '0.00')
  assert.equal(chart.xAxis.max, 9)
  assert.equal(chart.yAxis.max, 50)
  assert.deepEqual(chart.valueAxis, { min: 10, max: 50 })
})

test('resolves an embedded picture without mislabeling unsupported or external drawing objects', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const existing = await textOf(zip)(drawingPath)
  const picture = (id, extra = '') => `<xdr:oneCellAnchor ${extra}><xdr:from><xdr:col>1</xdr:col><xdr:colOff>250</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>500</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="476250"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="42" name="Banner" descr="Logo &amp; label"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${id}"><a:alphaModFix amt="50000"/></a:blip><a:srcRect l="10000"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`
  const shape = '<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="10000" cy="10000"/><xdr:sp/></xdr:absoluteAnchor>'
  zip.file(drawingPath, existing.replace('<xdr:wsDr ', `<xdr:wsDr xmlns:r="${relationships.slice(0, -1)}" `)
    .replace('</xdr:wsDr>', `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="xdr">${shape}</mc:Choice><mc:Fallback>${shape}</mc:Fallback></mc:AlternateContent>${picture('rId2')}${picture('rId3')}</xdr:wsDr>`))
  zip.file(drawingRels, (await textOf(zip)(drawingRels)).replace('</Relationships>',
    `<Relationship Id="rId2" Type="${relationships}image" Target="../media/banner.png"/><Relationship Id="rId3" Type="${relationships}image" Target="https://example.com/photo.png" TargetMode="External"/></Relationships>`))
  zip.file('xl/media/banner.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const visuals = await readWorkbookVisuals(textOf(zip), sourceSheet, [], path => Boolean(zip.file(path)))
  const [chart, image, ...rest] = workbookFileSchema.shape.visuals.parse(JSON.parse(JSON.stringify(visuals)))
  assert.equal(chart.kind, 'chart')
  assert.equal(rest.length, 0)
  assert.equal(image.kind, 'image')
  assert.equal(image.drawingIndex, 3)
  assert.equal(image.id, 'visual-4')
  assert.equal(image.mediaPath, 'xl/media/banner.png')
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.altText, 'Logo & label')
  assert.equal(image.opacity, 0.5)
  assert.deepEqual(image.crop, { left: 0.1, top: 0, right: 0, bottom: 0 })
  assert.deepEqual(image.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 500, fromColumnOffset: 250,
    toRow: 2, toColumn: 1, toRowOffset: 476750, toColumnOffset: 952750,
  })
})

test('opens a native XLSX text box and edits its paint at the original drawing index', async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  await appendDrawing(zip, `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="10000" cy="10000"/><xdr:sp/></xdr:absoluteAnchor>
    <xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
      <xdr:ext cx="952500" cy="476250"/>
      <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="81" name="Audit text box" descr="Quarterly &amp; annual"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>
        <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
          <a:ln w="25400" cap="rnd"><a:solidFill><a:srgbClr val="223344"/></a:solidFill><a:prstDash val="dash"/></a:ln></xdr:spPr>
        <xdr:txBody><a:bodyPr anchor="b" vertOverflow="clip"/><a:lstStyle/>
          <a:p><a:pPr algn="ctr"/><a:r><a:rPr b="1" sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Existing rectangle text</a:t></a:r><a:br/><a:r><a:t>Q1 &amp; Q2</a:t></a:r></a:p>
          <a:p><a:r><a:t>Total</a:t></a:r></a:p>
        </xdr:txBody>
      </xdr:sp><xdr:clientData/>
    </xdr:oneCellAnchor>`)
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-native-shapes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const visuals = (await runtime.sheetsNative.inspect(bytes, undefined, true)).visuals
  assert.deepEqual(visuals.map(({ kind, id }) => [kind, id]), [['chart', 'visual-1'], ['shape', 'visual-3']])
  const shape = visuals[1]
  assert.deepEqual({
    sheetId: shape.sheetId, drawingPath: shape.drawingPath, drawingIndex: shape.drawingIndex,
    name: shape.name, altText: shape.altText, shapeType: shape.shapeType, fillColor: shape.fillColor,
    lineColor: shape.lineColor, lineWidth: shape.lineWidth, lineDash: shape.lineDash, lineCap: shape.lineCap,
    text: shape.text, textAnchor: shape.textAnchor, textVertOverflow: shape.textVertOverflow,
  }, {
    sheetId: 'sheet-1', drawingPath, drawingIndex: 2,
    name: 'Audit text box', altText: 'Quarterly & annual', shapeType: 'rect', fillColor: '#FF0000',
    lineColor: '#223344', lineWidth: 2, lineDash: 'dash', lineCap: 'rnd',
    text: 'Existing rectangle text\nQ1 & Q2\nTotal', textAnchor: 'b', textVertOverflow: 'clip',
  })
  assert.deepEqual(shape.anchor, {
    fromRow: 4, fromColumn: 3, fromRowOffset: 0, fromColumnOffset: 0,
    toRow: 4, toColumn: 3, toRowOffset: 476250, toColumnOffset: 952500,
  })
  assert.equal(shape.paragraphs[0].align, 'ctr')
  assert.deepEqual(shape.paragraphs[0].runs[0], {
    text: 'Existing rectangle text', color: '#FFFFFF', size: 18, bold: true, italic: false, underline: false,
  })
  const request = sheetsSaveRequest('sheet-1', [{ row: 2, column: 0, writeValue: true, value: 99 }])
  request.visualEdits = [{ drawingPath: shape.drawingPath, drawingIndex: shape.drawingIndex, fillColor: '#00FF00' }]
  const plan = await runtime.sheetsWorkbookPlanner(bytes, request)
  const output = (await runtime.sheetsNative.savePlan(bytes, plan)).bytes
  const reopened = (await runtime.sheetsNative.inspect(output, undefined, true)).visuals
  assert.deepEqual(reopened, [visuals[0], { ...shape, fillColor: '#00FF00' }])
  const savedDrawing = await textOf(await JSZip.loadAsync(output))(drawingPath)
  assert.match(savedDrawing, /<xdr:cNvPr id="81" name="Audit text box"/)
})

test('places nested group shapes and straight connectors with read-only child locators', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  await appendDrawing(zip, `<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>1000</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>2000</xdr:rowOff></xdr:from>
    <xdr:ext cx="400000" cy="240000"/><xdr:grpSp>
      <xdr:nvGrpSpPr><xdr:cNvPr id="90" name="Outer group"/></xdr:nvGrpSpPr>
      <xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="400000" cy="240000"/><a:chOff x="100000" y="200000"/><a:chExt cx="200000" cy="120000"/></a:xfrm></xdr:grpSpPr>
      <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="91" name="Ellipse"/></xdr:nvSpPr>
        <xdr:spPr><a:xfrm><a:off x="125000" y="210000"/><a:ext cx="50000" cy="25000"/></a:xfrm><a:prstGeom prst="ellipse"/><a:ln><a:noFill/></a:ln></xdr:spPr>
        <xdr:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef></xdr:style>
      </xdr:sp>
      <xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="92" name="Inner group"/></xdr:nvGrpSpPr>
        <xdr:grpSpPr><a:xfrm><a:off x="200000" y="240000"/><a:ext cx="50000" cy="50000"/><a:chOff x="50000" y="60000"/><a:chExt cx="50000" cy="100000"/></a:xfrm></xdr:grpSpPr>
        <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="93" name="Hidden" hidden="1"/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="60000" y="70000"/><a:ext cx="30000" cy="15000"/></a:xfrm><a:prstGeom prst="rect"/></xdr:spPr></xdr:sp>
        <xdr:cxnSp><xdr:nvCxnSpPr><xdr:cNvPr id="94" name="Straight line"/></xdr:nvCxnSpPr>
          <xdr:spPr><a:xfrm flipH="1"><a:off x="70000" y="70000"/><a:ext cx="20000" cy="0"/></a:xfrm><a:prstGeom prst="straightConnector1"/><a:ln><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:ln></xdr:spPr>
        </xdr:cxnSp>
      </xdr:grpSp>
    </xdr:grpSp><xdr:clientData/></xdr:oneCellAnchor>`)
  const theme = ['#FFFFFF', '#000000', '#EEEEEE', '#111111', '#4472C4']
  const visuals = workbookFileSchema.shape.visuals.parse(await readWorkbookVisuals(textOf(zip), sourceSheet, theme))
  assert.deepEqual(visuals.map(({ id }) => id), ['visual-1', 'visual-2-1', 'visual-2-2'])
  const [, ellipse, line] = visuals
  assert.equal(ellipse.kind, 'shape')
  assert.equal(ellipse.name, 'Ellipse')
  assert.equal(ellipse.shapeType, 'ellipse')
  assert.equal(ellipse.drawingPath, drawingPath)
  assert.equal(ellipse.drawingIndex, undefined)
  assert.equal(ellipse.fillColor, '#4472C4')
  assert.equal(ellipse.lineColor, 'none')
  assert.deepEqual(ellipse.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 22000, fromColumnOffset: 51000,
    toRow: 2, toColumn: 1, toRowOffset: 72000, toColumnOffset: 151000,
  })
  assert.equal(line.name, 'Straight line')
  assert.equal(line.shapeType, 'straightConnector1')
  assert.equal(line.drawingIndex, undefined)
  assert.equal(line.flipH, true)
  assert.equal(line.lineColor, '#123456')
  assert.deepEqual(line.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 92000, fromColumnOffset: 241000,
    toRow: 2, toColumn: 1, toRowOffset: 92000, toColumnOffset: 281000,
  })
})
