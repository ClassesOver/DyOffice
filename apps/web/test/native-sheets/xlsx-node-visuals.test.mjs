import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import JSZip from 'jszip'
import { workbookFileSchema } from '../../../sheets/src/shared/desktop-api.ts'
import { readWorkbookVisuals } from '../../server/sheets/xlsx-node-visuals.ts'

const fixture = new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)
const nativeReplay = new URL('../fixtures/sheets/assistant-replay.json', import.meta.url)
const sourceSheet = [{ id: 'sheet-1', name: 'Acceptance' }]
const textOf = zip => async path => await zip.file(path)?.async('string') ?? ''
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const drawingPath = 'xl/drawings/drawing1.xml'
const drawingRels = 'xl/drawings/_rels/drawing1.xml.rels'
const chartPath = 'xl/charts/chart1.xml'

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
