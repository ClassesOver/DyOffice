import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { applyChartStateEdit } from '@genoffice/xlsx-gateway/domain/chart-visual'
import { changedPositions, reorderZ } from '../../../sheets/src/renderer/visual-arrange.ts'
import { workbookFileSchema, workbookRangeResultSchema } from '../../../sheets/src/shared/desktop-api.ts'
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

test('resolves legacy workbook-relative targets consistently for cells and drawings', { timeout: 120_000 }, async t => {
  const original = await readFile(fixture)
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-worksheet-target-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const workbookRels = 'xl/_rels/workbook.xml.rels'
  for (const target of ['xl/worksheets/sheet1.xml', String.raw` xl\worksheets\sheet1.xml `, '/xl/worksheets/sheet1.xml']) {
    const zip = await JSZip.loadAsync(original)
    const rels = (await textOf(zip)(workbookRels)).replace('Target="worksheets/sheet1.xml"', `Target="${target}"`)
    zip.file(workbookRels, rels)
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const range = await runtime.sheetsNative.readRange(source, 'Acceptance',
      { startRow: 1, endRow: 1, startColumn: 2, endColumn: 2 })
    assert.equal(range.cells[0].value, 45292, target)
    assert.equal(range.cells[0].styleIndex, 1, target)
    assert.equal((await runtime.sheetsNative.inspect(source)).visuals[0]?.chartPath, chartPath, target)
    const edit = sheetsSaveRequest('sheet-1', [{ row: 0, column: 0, value: 'Updated', writeValue: true }])
    const plan = await runtime.sheetsWorkbookPlanner(source, edit)
    const saved = (await runtime.sheetsNative.savePlan(source, plan)).bytes
    assert.equal((await runtime.sheetsNative.inspect(saved)).visuals[0]?.chartPath, chartPath, target)
    const actual = await runtime.sheetsNative.readRange(saved, 'Acceptance',
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })
    assert.equal(actual.cells[0].value, 'Updated', target)
    assert.equal(await textOf(await JSZip.loadAsync(saved))(workbookRels), rels)
  }
})

async function appendDrawing(zip, markup) {
  const source = await textOf(zip)(drawingPath)
  zip.file(drawingPath, (source.includes('xmlns:a=') ? source : source.replace('<xdr:wsDr ', `<xdr:wsDr xmlns:a="${mainNs}" `))
    .replace('</xdr:wsDr>', markup + '</xdr:wsDr>'))
}

test('opens a chart sheet and preserves its chart through a Web save', { timeout: 120_000 }, async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const text = textOf(zip)
  const workbook = 'xl/workbook.xml'
  const workbookRels = 'xl/_rels/workbook.xml.rels'
  const chartSheet = 'xl/chartsheets/sheet1.xml'
  const chartSheetRels = 'xl/chartsheets/_rels/sheet1.xml.rels'
  const headerVmlPath = 'xl/drawings/chart-header.vml'
  const headerVml = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">' +
    '<v:shape id="LH" style="width:1in;height:48px"><v:imagedata o:relid="logo"/></v:shape></xml>'
  const headerPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT4sAAAAASUVORK5CYII='
  const extension = '<extLst><ext uri="urn:example"><sheetPr xmlns="urn:example"><tabColor rgb="FF999999"/></sheetPr><sheetData xmlns="urn:example"/></ext></extLst>'
  zip.file(workbook, (await text(workbook))
    .replace('<workbookView/>', '<workbookView activeTab="1"/>')
    .replace('</sheets>', '<sheet name="Chart" sheetId="9" r:id="rId9"/></sheets>'))
  zip.file(workbookRels, (await text(workbookRels)).replace('</Relationships>',
    `<Relationship Id="rId9" Type="${relationships}chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`))
  zip.file('[Content_Types].xml', (await text('[Content_Types].xml')).replace('</Types>',
    '<Default Extension="png" ContentType="image/png"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>' +
    `<Override PartName="/${chartSheet}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/></Types>`))
  zip.file(chartSheet, `<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    xmlns:r="${relationships.slice(0, -1)}"><sheetPr><tabColor rgb="FF112233"/></sheetPr><sheetViews><sheetView workbookViewId="0" tabSelected="1" zoomScale="125" zoomToFit="1"/></sheetViews><pageSetup firstPageNumber="8" useFirstPageNumber="1"/><headerFooter><oddHeader>&amp;L&amp;G</oddHeader></headerFooter><drawing r:id="rId1"/><legacyDrawingHF r:id="header"/>${extension}</chartsheet>`)
  zip.file(chartSheetRels, (await text('xl/worksheets/_rels/sheet1.xml.rels')).replace('</Relationships>',
    `<Relationship Id="header" Type="${relationships}vmlDrawing" Target="../drawings/chart-header.vml"/></Relationships>`))
  zip.file(headerVmlPath, headerVml)
  zip.file('xl/drawings/_rels/chart-header.vml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="logo" Type="${relationships}image" Target="../media/chart-header.png"/></Relationships>`)
  zip.file('xl/media/chart-header.png', Buffer.from(headerPng, 'base64'))
  const worksheet = 'xl/worksheets/sheet1.xml'
  zip.file(worksheet, (await text(worksheet))
    .replace(/<drawing\b[^>]*\/>/, '')
    .replace('</worksheet>', '<pageSetup firstPageNumber="19" useFirstPageNumber="0"/></worksheet>'))
  zip.file(drawingPath, (await text(drawingPath))
    .replace(/<xdr:twoCellAnchor><xdr:from>[\s\S]*?<\/xdr:to>/,
      '<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="9304587" cy="6077107"/>')
    .replace('</xdr:twoCellAnchor>', '</xdr:absoluteAnchor>'))
  const styledLegend = '<c:legend><c:legendPos val="r"/><c:overlay val="1"/>' +
    '<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1300"/></a:pPr></a:p></c:txPr></c:legend>'
  zip.file(chartPath, (await text(chartPath))
    .replace('</c:plotArea>', '</c:plotArea>' + styledLegend)
    .replace('<c:axPos val="b"/>', '<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr></a:p></c:txPr>')
    .replace('<c:axPos val="l"/>', `<c:title><c:tx><c:rich><a:bodyPr/><a:p>
      <a:pPr><a:defRPr/></a:pPr>
      <a:r><a:rPr sz="1250"><a:solidFill><a:srgbClr val="2468AC"/></a:solidFill></a:rPr><a:t>Revenue</a:t></a:r>
      </a:p></c:rich></c:tx></c:title><c:numFmt formatCode="0.0" sourceLinked="0"/>`)
    .replace('</c:valAx>', `<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1100">
      <a:solidFill><a:srgbClr val="345678"/></a:solidFill>
      </a:defRPr></a:pPr></a:p></c:txPr>
      <c:dispUnits><c:builtInUnit val="thousands"/><c:dispUnitsLbl/></c:dispUnits></c:valAx>`))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })

  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-chart-sheet-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const inspect = async (input, tabColor, zoomScale = 125) => {
    const metadata = await runtime.sheetsNative.inspect(input)
    assert.deepEqual(metadata.sheets.map(({ name }) => name), ['Acceptance', 'Chart'])
    assert.equal(metadata.sheets[metadata.activeTab].id, 'sheet-9')
    assert.equal(metadata.sheets[metadata.activeTab].tabColor, tabColor)
    assert.equal(workbookFileSchema.shape.sheets.element.parse(metadata.sheets[1]).chartSheet, true)
    assert.equal(metadata.sheets[0].chartSheet, undefined)
    assert.equal(metadata.sheets[1].zoomScale, zoomScale)
    assert.equal(metadata.sheets[1].showGridLines, false)
    assert.equal(metadata.sheets[1].showRowColHeaders, false)
    assert.equal(metadata.sheets[0].showGridLines, true)
    const visual = metadata.visuals.find(({ sheetId }) => sheetId === 'sheet-9')
    assert.equal(visual?.kind, 'chart')
    assert.equal(visual.chartPath, chartPath)
    assert.equal(visual.anchor.toColumnOffset, 9304587)
    return visual.chart
  }
  const original = await inspect(bytes, '#112233')
  assert.equal(original.xAxis?.labelSize, 9)
  assert.equal(original.yAxis?.title, 'Revenue')
  assert.equal(original.yAxis?.titleSize, 12.5)
  assert.equal(original.yAxis?.titleColor, '#2468AC')
  assert.equal(original.yAxis?.labelSize, 11)
  assert.equal(original.yAxis?.labelColor, '#345678')
  assert.equal(original.yAxis?.displayUnit, 1e3)
  assert.equal(original.yAxis?.displayUnitLabel, 'Thousands')
  assert.equal(original.yAxis?.numFmt, '0.0')
  assert.equal(original.legend, 'right')
  const inspectHeaderPicture = async (input, sheetName = 'Chart') => {
    const range = await runtime.sheetsNative.readRange(input, sheetName,
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })
    const { pageSetup } = workbookRangeResultSchema.parse(range)
    assert.equal(pageSetup.firstPageNumber, 8)
    assert.equal(pageSetup.headerFooterPictures?.length, 1)
    const [{ id, ...picture }] = pageSetup.headerFooterPictures
    assert.deepEqual(picture, { position: 'LH', widthPt: 72, heightPt: 36, mediaType: 'image/png' })
    assert.deepEqual(await runtime.sheetsNative.readMedia(input, id), { mediaType: 'image/png', base64: headerPng })
    return pageSetup
  }
  assert.equal((await inspectHeaderPicture(bytes)).oddHeader, '&L&G')
  const printRequest = sheetsSaveRequest('sheet-9', [])
  printRequest.pageSetupStates = [
    { sheetId: 'sheet-9', orientation: 'landscape', paperSize: 9,
      margins: 'narrow', header: { left: '&G', center: 'Chart &P' }, footer: { right: 'Quarterly' } },
    { sheetId: 'sheet-1', orientation: 'portrait', printGridlines: true },
  ]
  const printSaved = (await runtime.sheetsNative.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, printRequest))).bytes
  const printSetup = await inspectHeaderPicture(printSaved)
  assert.equal(printSetup.orientation, 'landscape')
  assert.equal(printSetup.paperSize, 9)
  assert.equal(printSetup.margins.left, 0.25)
  assert.equal(printSetup.oddHeader, '&L&G&CChart &P')
  assert.equal(printSetup.oddFooter, '&RQuarterly')
  const worksheetPrintRange = await runtime.sheetsNative.readRange(printSaved, 'Acceptance',
    { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })
  assert.equal(worksheetPrintRange.pageSetup.orientation, 'portrait')
  assert.equal(worksheetPrintRange.pageSetup.printGridlines, true)
  assert.equal(worksheetPrintRange.pageSetup.firstPageNumber, undefined)
  const printedPackage = textOf(await JSZip.loadAsync(printSaved))
  const printXml = await printedPackage(chartSheet)
  assert.match(printXml, /<pageMargins\b[^>]*\/><pageSetup\b[^>]*\/><headerFooter>[\s\S]*?<\/headerFooter><drawing/)
  assert.ok(printXml.includes(extension))
  assert.equal(await printedPackage(headerVmlPath), headerVml)
  const request = sheetsSaveRequest('sheet-1', [{ row: 0, column: 7, value: 42, writeValue: true }])
  request.pageSetupStates = [{ sheetId: 'sheet-9', zoomScale: 150 }]
  request.chartEdits = [{ chartPath, title: 'Chart sheet revenue', legend: 'bottom', axisTitles: { value: 'Net revenue' } }]
  request.sheetOps = [
    { kind: 'set-sheet-tab-color', sheetId: 'sheet-9', color: '#654321' },
    { kind: 'set-sheet-tab-color', sheetId: 'sheet-1', color: '#123456' },
  ]
  const save = async (input, edit) =>
    (await runtime.sheetsNative.savePlan(input, await runtime.sheetsWorkbookPlanner(input, edit))).bytes
  const saved = await save(bytes, request)
  const chart = await inspect(saved, '#654321', 150)
  const savedSheet = await textOf(await JSZip.loadAsync(saved))(chartSheet)
  assert.match(savedSheet, /<sheetView\b[^>]*tabSelected="1"[^>]*zoomScale="150"/)
  assert.match(savedSheet, /<sheetView\b[^>]*zoomToFit="0"/)
  assert.ok(!savedSheet.includes('zoomScaleNormal'))
  assert.equal((await runtime.sheetsNative.inspect(saved)).sheets[0].tabColor, '#123456')
  assert.equal(chart.title, 'Chart sheet revenue')
  assert.deepEqual(chart.series, original.series)
  assert.deepEqual(chart.xAxis, original.xAxis)
  assert.deepEqual(chart.yAxis, { ...original.yAxis, title: 'Net revenue' })
  assert.equal(chart.legend, 'bottom')
  const savedPart = await textOf(await JSZip.loadAsync(saved))(chartPath)
  assert.ok(savedPart.includes(styledLegend.replace('val="r"', 'val="b"')))
  const range = await runtime.sheetsNative.readRange(saved, 'Acceptance',
    { startRow: 0, endRow: 0, startColumn: 7, endColumn: 7 })
  assert.equal(range.cells[0].value, 42)
  const clear = sheetsSaveRequest('sheet-9', [])
  clear.sheetOps = [{ kind: 'set-sheet-tab-color', sheetId: 'sheet-9', color: null }]
  const cleared = await save(saved, clear)
  assert.equal((await inspect(cleared, null, 150)).title, 'Chart sheet revenue')
  const xml = await textOf(await JSZip.loadAsync(cleared))(chartSheet)
  assert.ok(xml.includes(extension))
  assert.ok(!xml.replace(extension, '').includes('<sheetData'))
  const recolor = sheetsSaveRequest('sheet-9', [])
  recolor.sheetOps = [{ kind: 'set-sheet-tab-color', sheetId: 'sheet-9', color: '#ABCDEF' }]
  assert.equal((await inspect(await save(cleared, recolor), '#ABCDEF', 150)).title, 'Chart sheet revenue')
  const cellEdit = sheetsSaveRequest('sheet-9', [{ row: 0, column: 0, value: 'invalid', writeValue: true }])
  await assert.rejects(save(cleared, cellEdit), /Invalid workbook input/)
  cellEdit.pageSetupStates = [{ sheetId: 'sheet-9', zoomScale: 150 }]
  await assert.rejects(save(cleared, cellEdit), /Invalid workbook input/)
  const gridPrintSetting = sheetsSaveRequest('sheet-9', [])
  gridPrintSetting.pageSetupStates = [{ sheetId: 'sheet-9', orientation: 'portrait', printGridlines: true }]
  await assert.rejects(save(cleared, gridPrintSetting), /Invalid workbook input/)

  const duplicate = sheetsSaveRequest('sheet-9', [])
  duplicate.sheetOps = [{ kind: 'duplicate-sheet', sheetId: 'chart-copy', sourceSheetId: 'sheet-9', name: 'Chart Copy' }]
  duplicate.sheetOrder = ['sheet-1', 'sheet-9', 'chart-copy']
  const copied = await save(saved, duplicate)
  const copiedMetadata = await runtime.sheetsNative.inspect(copied)
  const copy = copiedMetadata.sheets.find(({ name }) => name === 'Chart Copy')
  assert.equal(copy?.tabColor, '#654321')
  assert.equal(copy?.zoomScale, 150)
  assert.equal(copy?.chartSheet, true)
  assert.equal((await inspectHeaderPicture(copied, 'Chart Copy')).oddHeader, '&L&G')
  const copiedVisual = copiedMetadata.visuals.find(({ sheetId }) => sheetId === copy.id)
  assert.equal(copiedVisual?.kind, 'chart')
  assert.notEqual(copiedVisual.chartPath, chartPath)
  assert.notEqual(copiedVisual.drawingPath, drawingPath)
  assert.deepEqual(copiedVisual.chart.series, chart.series)
  const editCopy = sheetsSaveRequest(copy.id, [])
  editCopy.chartEdits = [{ chartPath: copiedVisual.chartPath, title: 'Independent chart copy' }]
  const edited = await save(copied, editCopy)
  const editedMetadata = await runtime.sheetsNative.inspect(edited)
  assert.deepEqual(new Map(editedMetadata.visuals.map(visual => [visual.sheetId, visual.chart.title])),
    new Map([['sheet-9', 'Chart sheet revenue'], [copy.id, 'Independent chart copy']]))
  const copiedPart = await textOf(await JSZip.loadAsync(copied))('xl/chartsheets/sheet2.xml')
  assert.ok(copiedPart.includes(extension))
  assert.ok(!copiedPart.includes('tabSelected'))
  const removeCopy = sheetsSaveRequest('sheet-9', [])
  removeCopy.sheetOps = [{ kind: 'remove-sheet', sheetId: copy.id }]
  removeCopy.sheetOrder = ['sheet-1', 'sheet-9']
  const removed = await save(edited, removeCopy)
  assert.equal((await inspect(removed, '#654321', 150)).title, 'Chart sheet revenue')
  assert.equal((await inspectHeaderPicture(removed)).oddHeader, '&L&G')
  assert.equal((await JSZip.loadAsync(removed)).file(copiedVisual.chartPath), null)
})

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

test('edits and deletes a chart in a package subdirectory', { timeout: 120_000 }, async t => {
  const book = await JSZip.loadAsync(await readFile(fixture))
  const nestedChart = 'xl/charts/reports/Revenue 零.xml'
  const encodedChart = 'xl/charts/reports/Revenue%20%E9%9B%B6.xml'
  const contentTypes = '[Content_Types].xml'
  book.file(nestedChart, await textOf(book)(chartPath))
  book.remove(chartPath)
  book.file(contentTypes, (await textOf(book)(contentTypes)).replace(chartPath, encodedChart))
  book.file(drawingRels, (await textOf(book)(drawingRels)).replace('../charts/chart1.xml',
    '../' + encodedChart.slice('xl/'.length)))
  const source = await book.generateAsync({ type: 'nodebuffer' })
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-nested-chart-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const save = async (input, request) =>
    (await runtime.sheetsNative.savePlan(input, await runtime.sheetsWorkbookPlanner(input, request))).bytes

  const { sheets: [sheet], visuals: [chart] } = await runtime.sheetsNative.inspect(source)
  assert.equal(chart.chartPath, nestedChart)
  const edit = sheetsSaveRequest(sheet.id, [])
  edit.chartEdits = [{ chartPath: chart.chartPath, title: 'Quarterly revenue' }]
  const updated = await save(source, edit)
  assert.equal((await runtime.sheetsNative.inspect(updated)).visuals[0].chart.title, 'Quarterly revenue')

  const remove = sheetsSaveRequest(sheet.id, [])
  remove.visualEdits = [{ drawingPath: chart.drawingPath, drawingIndex: chart.drawingIndex, remove: true }]
  const deleted = await save(updated, remove)
  assert.deepEqual((await runtime.sheetsNative.inspect(deleted)).visuals, [])
  const deletedZip = await JSZip.loadAsync(deleted)
  assert.equal(deletedZip.file(nestedChart), null)
  assert.ok(!(await textOf(deletedZip)(contentTypes)).includes(encodedChart))
})

test('duplicates a worksheet with an independently editable embedded chart', { timeout: 120_000 }, async t => {
  const book = await JSZip.loadAsync(await readFile(fixture))
  const sheet = 'xl/worksheets/sheet1.xml'
  const sheetRels = 'xl/worksheets/_rels/sheet1.xml.rels'
  const media = 'xl/media/sheet-background.png'
  const background = '<picture r:id="rIdBackground"/>'
  const image = `<Relationship Id="rIdBackground" Type="${relationships}image" Target="../media/sheet-background.png"/>`
  const foreign = `<Relationship xmlns="urn:example:opaque" Type="${relationships}printerSettings" Target="opaque"/>`
  book.file(sheet, (await textOf(book)(sheet)).replace('</worksheet>', background + '</worksheet>'))
  book.file(sheetRels, (await textOf(book)(sheetRels)).replace('</Relationships>', foreign + image + '</Relationships>'))
  const foreignAnchor = '<xdr:extLst><xdr:ext uri="urn:example:cache"><xdr:from><xdr:row>8</xdr:row></xdr:from></xdr:ext></xdr:extLst>'
  const foreignRow = '<row xmlns="urn:example:cache">99</row>'
  const comment = '<!-- <xdr:twoCellAnchor><xdr:from><xdr:row>100</xdr:row></xdr:from></xdr:twoCellAnchor> -->'
  book.file(drawingPath, (await textOf(book)(drawingPath))
    .replace(/<xdr:from>[\s\S]*?<\/xdr:from>/, (from) => from
      .replace('<xdr:from>', '<xdr:from xmlns:cache="urn:example:cache" cache:keep="1">')
      .replace(/<xdr:row>([0-9]+)<\/xdr:row>/, (_, row) => `${foreignRow}<xdr:row><![CDATA[${row}]]></xdr:row>`))
    .replace('<xdr:twoCellAnchor>', comment + '<xdr:twoCellAnchor>')
    .replace('</xdr:wsDr>', foreignAnchor + '</xdr:wsDr>'))
  book.file(media, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const contentTypes = '[Content_Types].xml'
  const types = await textOf(book)(contentTypes)
  if (!types.includes('Extension="png"')) {
    book.file(contentTypes, types.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'))
  }
  const bytes = await book.generateAsync({ type: 'nodebuffer' })
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-worksheet-chart-copy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const save = async (input, request) =>
    (await runtime.sheetsNative.savePlan(input, await runtime.sheetsWorkbookPlanner(input, request))).bytes
  const duplicate = sheetsSaveRequest('sheet-1', [])
  duplicate.sheetOps = [
    { kind: 'duplicate-sheet', sheetId: 'worksheet-copy', sourceSheetId: 'sheet-1', name: 'Worksheet Copy' },
    { kind: 'rename-sheet', sheetId: 'sheet-1', newName: 'Original Data' },
  ]
  duplicate.sheetOrder = ['sheet-1', 'worksheet-copy']
  duplicate.structuralOps = [{ kind: 'insert-rows', sheetId: 'worksheet-copy', index: 0, count: 1 }]
  const copied = await save(bytes, duplicate)
  const metadata = await runtime.sheetsNative.inspect(copied)
  assert.deepEqual(metadata.sheets.map(({ name }) => name), ['Original Data', 'Worksheet Copy'])
  const [originalSheet, copiedSheet] = metadata.sheets
  const original = metadata.visuals.find(({ sheetId }) => sheetId === originalSheet.id)
  const copy = metadata.visuals.find(({ sheetId }) => sheetId === copiedSheet.id)
  assert.equal(original?.chartPath, chartPath)
  assert.equal(copy?.kind, 'chart')
  assert.notEqual(copy.chartPath, original.chartPath)
  assert.notEqual(copy.drawingPath, original.drawingPath)
  assert.deepEqual(copy.anchor, {
    ...original.anchor, fromRow: original.anchor.fromRow + 1, toRow: original.anchor.toRow + 1,
  })
  assert.equal(original.chart.series[0].valuesRef, "'Original Data'!$A$2:$A$3")
  assert.equal(copy.chart.series[0].valuesRef, "'Worksheet Copy'!$A$3:$A$4")
  assert.deepEqual(copy.chart.series[0].values, original.chart.series[0].values)
  const copiedZip = await JSZip.loadAsync(copied)
  assert.ok((await textOf(copiedZip)(copy.drawingPath)).includes(foreignAnchor))
  assert.ok((await textOf(copiedZip)(copy.drawingPath)).includes(foreignRow))
  assert.ok(original.anchor.fromRow < 99)
  const copiedSheetPath = 'xl/worksheets/sheet2.xml'
  const copiedRelsPath = 'xl/worksheets/_rels/sheet2.xml.rels'
  assert.ok((await textOf(copiedZip)(copiedSheetPath)).includes(background))
  const clonedRels = await textOf(copiedZip)(copiedRelsPath)
  assert.ok(clonedRels.includes(image))
  assert.ok(clonedRels.includes(foreign))
  assert.deepEqual(await copiedZip.file(media).async('nodebuffer'), await book.file(media).async('nodebuffer'))
  const value = await runtime.sheetsNative.readRange(copied, 'Worksheet Copy',
    { startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 })
  assert.equal(value.cells[0].value, 'Revenue')
  const edit = sheetsSaveRequest(copiedSheet.id, [])
  edit.chartEdits = [{ chartPath: copy.chartPath, title: 'Worksheet copy chart' }]
  const moved = { ...copy.anchor, fromRow: copy.anchor.fromRow + 1, toRow: copy.anchor.toRow + 1 }
  edit.visualEdits = [{ drawingPath: copy.drawingPath, drawingIndex: copy.drawingIndex, anchor: moved }]
  const edited = await save(copied, edit)
  const reopened = await runtime.sheetsNative.inspect(edited)
  assert.equal(reopened.visuals.find(({ chartPath: path }) => path === chartPath)?.chart.title, original.chart.title)
  const editedCopy = reopened.visuals.find(({ chartPath: path }) => path === copy.chartPath)
  assert.equal(editedCopy?.chart.title, 'Worksheet copy chart')
  assert.deepEqual(editedCopy?.anchor, moved)
  const editedDrawing = await textOf(await JSZip.loadAsync(edited))(copy.drawingPath)
  for (const preserved of [foreignAnchor, foreignRow, comment, 'cache:keep="1"']) assert.ok(editedDrawing.includes(preserved))
  const remove = sheetsSaveRequest(originalSheet.id, [])
  remove.sheetOps = [{ kind: 'remove-sheet', sheetId: copiedSheet.id }]
  remove.sheetOrder = [originalSheet.id]
  const removed = await save(edited, remove)
  const [remaining] = (await runtime.sheetsNative.inspect(removed)).visuals
  assert.equal(remaining.chartPath, chartPath)
  assert.equal(remaining.chart.title, original.chart.title)
  assert.equal((await JSZip.loadAsync(removed)).file(copy.chartPath), null)

  const withoutGlobalName = await JSZip.loadAsync(bytes)
  const workbookXml = await textOf(withoutGlobalName)('xl/workbook.xml')
  withoutGlobalName.file('xl/workbook.xml', workbookXml.replace(/<definedNames>[\s\S]*?<\/definedNames>/, ''))
  const replace = sheetsSaveRequest('sheet-1', [])
  replace.sheetOps = [duplicate.sheetOps[0], { kind: 'remove-sheet', sheetId: 'sheet-1' }]
  replace.sheetOrder = ['worksheet-copy']
  const replaced = await save(await withoutGlobalName.generateAsync({ type: 'nodebuffer' }), replace)
  const replacement = await runtime.sheetsNative.inspect(replaced)
  assert.deepEqual(replacement.sheets.map(({ name }) => name), ['Worksheet Copy'])
  assert.equal(replacement.visuals[0].chart.series[0].valuesRef, "'Worksheet Copy'!$A$2:$A$3")
  const replacementZip = await JSZip.loadAsync(replaced)
  assert.ok(replacementZip.file(media))
  assert.ok((await textOf(replacementZip)(copiedSheetPath)).includes(background))
})

test('loads combo series and secondary scale without losing sparse cache slots or uncached formulas', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const theme = ['#FFFFFF', '#000000', '#EEEEEE', '#111111', '#4472C4', '#ED7D31']
  zip.file(chartPath, `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><chart>
    <title><tx><rich><a:p><a:r><a:t>Revenue &amp; Margin</a:t></a:r></a:p></rich></tx></title>
    <plotArea><lineChart><ser><idx val="1"/><tx><strRef><f>Acceptance!B1</f></strRef></tx><cat><strRef><f>Acceptance!C2:C4</f><strCache><ptCount val="3"/><pt idx="2"><v>Dec</v></pt><pt idx="0"><v>Oct</v></pt></strCache></strRef></cat><val><numRef><f>Acceptance!B2:B4</f></numRef></val></ser><smooth/><axId val="3"/><axId val="4"/></lineChart>
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
  assert.equal(chart.series[0].smooth, true)
  assert.equal(chart.series[1].smooth, undefined)
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

test('preserves multi-level category bands when saving refreshed chart labels', { timeout: 120_000 }, async t => {
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
  const categories = ['Jan', '', 'March', 'Apr']
  request.chartEdits = [{ chartPath, title: 'Regional revenue',
    series: [{ index: 0, categoriesRef: series.categoriesRef, categories }] }]
  const plan = await runtime.sheetsWorkbookPlanner(bytes, request)
  const saved = (await runtime.sheetsNative.savePlan(bytes, plan)).bytes
  const reopened = await inspect(saved)
  assert.equal(reopened.title, 'Regional revenue')
  assert.deepEqual(reopened.series, [{ ...series, categories }])
  const xml = await textOf(await JSZip.loadAsync(saved))(chartPath)
  assert.ok(xml.includes('<c:lvl><c:pt idx="0"><c:v>All regions</c:v></c:pt></c:lvl>'))
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

test('keeps scatter X and Y caches separate and saves axis and color edits', async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const flippedDrawing = (await textOf(zip)(drawingPath)).replace('<xdr:xfrm>', '<xdr:xfrm flipH="1" flipV="true">')
  zip.file(drawingPath, flippedDrawing)
  const strokeStyle = '<a:prstDash val="dash"/><a:round/>'
  zip.file(chartPath, `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="${mainNs}"><c:chart><c:plotArea>
    <c:scatterChart><c:scatterStyle val="lineMarker"/><c:ser><c:tx><c:v>Observations</c:v></c:tx>
      <c:spPr><a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="010203"/></a:solidFill>${strokeStyle}</a:ln></c:spPr>
      <c:marker><c:symbol val="diamond"/></c:marker>
      <c:xVal><c:numRef><c:f>'Data Sheet'!$C$2:$C$3</c:f><c:numCache><c:formatCode>0.00</c:formatCode><c:pt idx="0"><c:v>0.1</c:v></c:pt><c:pt idx="1"><c:v>7.2</c:v></c:pt></c:numCache></c:numRef></c:xVal>
      <c:yVal><c:numRef><c:f>'Data Sheet'!$D$2:$D$3</c:f><c:numCache><c:pt idx="0"><c:v>20</c:v></c:pt><c:pt idx="1"><c:v>40</c:v></c:pt></c:numCache></c:numRef></c:yVal>
      <c:smooth val="1"/>
    </c:ser><c:axId val="1"/><c:axId val="2"/></c:scatterChart>
    <c:valAx><c:axId val="1"/><c:scaling><c:max val="9"/><c:min val="0"/></c:scaling><c:axPos val="b"/></c:valAx>
    <c:valAx><c:axId val="2"/><c:scaling><c:max val="50" /><c:min val="10"/></c:scaling><c:axPos val="l"/></c:valAx>
    </c:plotArea><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`)
  const [visual] = workbookFileSchema.shape.visuals.parse(await readWorkbookVisuals(textOf(zip), sourceSheet))
  const { chart } = visual
  assert.deepEqual([visual.flipH, visual.flipV], [true, true])
  assert.deepEqual(chart.chartTypes, ['scatterChart'])
  assert.equal(chart.scatterStyle, 'lineMarker')
  assert.equal(chart.dispBlanksAs, 'gap')
  assert.equal(chart.series[0].smooth, true)
  assert.deepEqual(chart.series[0].categories, ['0.1', '7.2'])
  assert.deepEqual(chart.series[0].values, [20, 40])
  assert.equal(chart.series[0].categoriesRef, "'Data Sheet'!$C$2:$C$3")
  assert.equal(chart.series[0].valuesRef, "'Data Sheet'!$D$2:$D$3")
  assert.equal(chart.series[0].categoryFormat, '0.00')
  assert.equal(chart.series[0].lineColor, '#010203')
  assert.equal(chart.series[0].lineDash, 'dash')
  assert.equal(chart.xAxis.max, 9)
  assert.equal(chart.yAxis.max, 50)
  assert.deepEqual(chart.valueAxis, { min: 10, max: 50 })

  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-scatter-axis-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const request = sheetsSaveRequest('sheet-1', [])
  request.chartEdits = [{
    chartPath,
    axisTitles: { value: 'Measured Y' },
    valueAxis: { max: 80 },
    gridlines: true,
    seriesColors: { 0: '#0099CC' },
    series: [{ index: 0, categories: ['1.25', '7.5'] }],
  }]
  const [previewSeries] = applyChartStateEdit(chart, request.chartEdits[0]).series
  const saved = (await runtime.sheetsNative.savePlan(source, await runtime.sheetsWorkbookPlanner(source, request))).bytes
  const [savedVisual] = (await runtime.sheetsNative.inspect(saved)).visuals
  const edited = savedVisual.chart
  assert.deepEqual([savedVisual.flipH, savedVisual.flipV], [true, true])
  assert.equal(await textOf(await JSZip.loadAsync(saved))(drawingPath), flippedDrawing)
  assert.deepEqual(edited.xAxis, JSON.parse(JSON.stringify(chart.xAxis)))
  assert.equal(edited.yAxis.title, 'Measured Y')
  assert.equal(edited.yAxis.majorGridlines, true)
  assert.deepEqual(edited.valueAxis, { min: 10, max: 80 })
  assert.equal(edited.series[0].lineColor, '#0099CC')
  assert.equal(edited.series[0].lineColor, previewSeries.lineColor)
  assert.equal(edited.series[0].lineWidth, chart.series[0].lineWidth)
  assert.equal(edited.series[0].lineDash, previewSeries.lineDash)
  assert.equal(edited.series[0].marker, 'diamond')
  assert.equal(edited.series[0].smooth, true)
  assert.equal(edited.dispBlanksAs, 'gap')
  assert.deepEqual(edited.series[0].categories, ['1.25', '7.5'])
  assert.equal(edited.series[0].categoriesRef, chart.series[0].categoriesRef)
  assert.equal(edited.series[0].categoryFormat, '0.00')
  assert.deepEqual(edited.series[0].values, [20, 40])
  const savedXml = await textOf(await JSZip.loadAsync(saved))(chartPath)
  assert.equal(savedXml.match(/<c:max\b/g).length, 2)
  assert.ok(savedXml.includes(strokeStyle))

  const retarget = sheetsSaveRequest('sheet-1', [])
  const newXRange = 'Acceptance!$A$2:$A$3'
  retarget.chartEdits = [{ chartPath, series: [{ index: 0, categoriesRef: newXRange, categories: [] }] }]
  const retargeted = (await runtime.sheetsNative.savePlan(saved, await runtime.sheetsWorkbookPlanner(saved, retarget))).bytes
  const [{ chart: reopened }] = (await runtime.sheetsNative.inspect(retargeted)).visuals
  assert.equal(reopened.series[0].categoriesRef, newXRange)
  assert.deepEqual(reopened.series[0].categories, [])
  assert.deepEqual(reopened.series[0].values, [20, 40])
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

test('saves picture transforms and absolute drawing coordinates', { timeout: 120_000 }, async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const extension = '<v:cache><a:xfrm rot="123"><a:ext cx="7" cy="8"/></a:xfrm></v:cache>'
  await appendDrawing(zip, `<xdr:oneCellAnchor xmlns:d="${mainNs}" xmlns:v="urn:example:cache" xmlns:r="${relationships.slice(0, -1)}">` +
    '<xdr:from><xdr:col>1</xdr:col><xdr:row>3</xdr:row></xdr:from><xdr:ext cx="300" cy="400"/>' +
    '<xdr:pic><xdr:blipFill><d:blip r:embed="photo"/></xdr:blipFill>' +
    `<xdr:spPr>${extension}<d:xfrm rot='60000'><d:ext cx="100" cy="200"></d:ext></d:xfrm></xdr:spPr>` +
    '</xdr:pic></xdr:oneCellAnchor>' +
    '<xdr:absoluteAnchor><xdr:pos x="12345" y="23456"/><xdr:ext cx="34567" cy="45678"/>' +
    '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="99" name="Absolute shape"/></xdr:nvSpPr>' +
    '<xdr:spPr><a:prstGeom prst="rect"/></xdr:spPr></xdr:sp><xdr:clientData/></xdr:absoluteAnchor>')
  zip.file(drawingRels, (await textOf(zip)(drawingRels)).replace('</Relationships>',
    `<Relationship Id="photo" Type="${relationships}image" Target="../media/photo.png"/></Relationships>`))
  zip.file('xl/media/photo.png', 'fixture')
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-picture-transform-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())

  const { visuals } = await runtime.sheetsNative.inspect(source)
  const photo = visuals.find(visual => visual.kind === 'image')
  assert.equal(photo.rotation, 1)
  const absolute = visuals.find(visual => visual.name === 'Absolute shape')
  assert.equal(absolute.anchor.absolute, true)

  const flip = sheetsSaveRequest(absolute.sheetId, [])
  flip.visualEdits = [{ drawingPath, drawingIndex: absolute.drawingIndex, flipH: true, flipV: true }]
  const flippedFile = (await runtime.sheetsNative.savePlan(source, await runtime.sheetsWorkbookPlanner(source, flip))).bytes
  const flipped = (await runtime.sheetsNative.inspect(flippedFile)).visuals.find(visual => visual.name === 'Absolute shape')
  assert.deepEqual([flipped.flipH, flipped.flipV], [true, true])
  assert.deepEqual(flipped.anchor, absolute.anchor)
  const edit = sheetsSaveRequest(photo.sheetId, [])
  edit.visualEdits = [{ drawingPath, drawingIndex: photo.drawingIndex, rotation: 90,
    flipH: true, frameSize: { width: 555, height: 333 },
    anchor: photo.anchor, anchorSize: { width: 333, height: 555 } },
  { drawingPath, drawingIndex: absolute.drawingIndex,
    anchor: { ...absolute.anchor, fromColumnOffset: 150000, fromRowOffset: 240000,
      toColumnOffset: 240000, toRowOffset: 440000 },
    anchorSize: { width: 90000, height: 200000 }, rotation: 90, frameSize: { width: 200000, height: 90000 } }]
  const plan = await runtime.sheetsWorkbookPlanner(source, edit)
  const { bytes } = await runtime.sheetsNative.savePlan(source, plan)
  const reopened = (await runtime.sheetsNative.inspect(bytes)).visuals
  const updated = reopened.find(visual => visual.kind === 'image')
  const rotated = reopened.find(visual => visual.name === 'Absolute shape')
  assert.deepEqual(rotated.anchor, edit.visualEdits[1].anchor)
  assert.deepEqual([rotated.rotation, rotated.frameWidth, rotated.frameHeight], [90, 200000, 90000])
  assert.deepEqual([updated.rotation, updated.flipH, updated.frameWidth, updated.frameHeight], [90, true, 555, 333])
  assert.equal(updated.anchor.toColumnOffset - updated.anchor.fromColumnOffset, 333)
  assert.equal(updated.anchor.toRowOffset - updated.anchor.fromRowOffset, 555)
  assert.ok((await textOf(await JSZip.loadAsync(bytes))(drawingPath)).includes(extension))
})

test('resolves drawing, chart, and picture relationships by their declared namespaces', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const worksheet = 'xl/worksheets/sheet1.xml'
  const rels = 'xl/worksheets/_rels/sheet1.xml.rels'
  const office = relationships.slice(0, -1)
  const foreign = 'urn:example:foreign'
  const declarations = `xmlns:p="${office}" xmlns:f="${foreign}"`
  zip.file(worksheet, (await textOf(zip)(worksheet)).replace(/<drawing r:id="([^"]+)"\/>/,
    (_, id) => `<f:drawing ${declarations} p:id="${id}"/><drawing ${declarations} p:id="${id}" f:id="wrong"/>`))
  zip.file(rels, (await textOf(zip)(rels)).replace('</Relationships>',
    `<Relationship xmlns="${foreign}" Id="rId1" Type="${relationships}drawing" Target="../drawings/missing.xml"/></Relationships>`))
  await appendDrawing(zip, '<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>3</xdr:row></xdr:from>' +
    '<xdr:ext cx="50" cy="60"/><xdr:pic><xdr:blipFill><f:blip p:embed="wrong"/><a:blip p:embed="image" f:embed="wrong"/></xdr:blipFill></xdr:pic>' +
    '</xdr:oneCellAnchor>')
  zip.file(drawingPath, (await textOf(zip)(drawingPath))
    .replace('<xdr:wsDr ', `<xdr:wsDr ${declarations} `)
    .replace(/<c:chart([^>]*)\br:id="([^"]+)"\/>/,
      (_, attrs, id) => `<f:chart p:id="wrong"/><c:chart${attrs} p:id="${id}" f:id="wrong"/>`))
  zip.file(drawingRels, (await textOf(zip)(drawingRels)).replace('</Relationships>',
    `<Relationship Id="image" Type="${relationships}image" Target="../media/actual.png"/>` +
    `<Relationship xmlns="${foreign}" Id="image" Type="${relationships}image" Target="../media/decoy.png"/></Relationships>`))
  zip.file('xl/media/actual.png', 'fixture')
  zip.file('xl/media/decoy.png', 'fixture')
  const visuals = await readWorkbookVisuals(textOf(zip), sourceSheet, [], path => Boolean(zip.file(path)))
  assert.deepEqual(visuals.map(visual => [visual.kind, visual.chartPath ?? visual.mediaPath]), [
    ['chart', chartPath], ['image', 'xl/media/actual.png'],
  ])
})

test('uses an internal SVG extension when a picture has no usable raster', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const office = relationships.slice(0, -1)
  const svg = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'
  const blip = (extensions, raster = '') => `<a:blip ${raster}><a:extLst><a:ext uri="svg">${extensions}</a:ext></a:extLst></a:blip>`
  const pic = (name, image) => `<xdr:oneCellAnchor xmlns:p="${office}" xmlns:s="${svg}" xmlns:f="urn:foreign">
    <xdr:from><xdr:col>1</xdr:col><xdr:row>3</xdr:row></xdr:from><xdr:ext cx="50" cy="60"/>
    <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="99" name="${name}"/></xdr:nvPicPr><xdr:blipFill>${image}</xdr:blipFill></xdr:pic>
    </xdr:oneCellAnchor>`
  await appendDrawing(zip,
    pic('Vector', blip('<f:svgBlip p:embed="foreign"/><s:svgBlip p:embed="vector"/>', 'p:embed="missing"')) +
    pic('Raster', blip('<s:svgBlip p:embed="vector"/>', 'p:embed="raster"')) +
    pic('External vector', blip('<s:svgBlip p:embed="externalVector"/>')))
  zip.file(drawingRels, (await textOf(zip)(drawingRels)).replace('</Relationships>', `
    <Relationship Id="vector" Type="${relationships}image" Target="../media/vector.svg"/>
    <Relationship Id="foreign" Type="${relationships}image" Target="../media/foreign.svg"/>
    <Relationship Id="raster" Type="${relationships}image" Target="../media/raster.png"/>
    <Relationship Id="missing" Type="${relationships}image" Target="../media/missing.png"/>
    <Relationship Id="externalVector" Type="${relationships}image" Target="https://example.invalid/vector.svg" TargetMode="External"/>
    </Relationships>`))
  for (const filename of ['vector.svg', 'foreign.svg', 'raster.png']) zip.file('xl/media/' + filename, 'fixture')
  const visuals = await readWorkbookVisuals(textOf(zip), sourceSheet, [], path => Boolean(zip.file(path)))
  assert.deepEqual(visuals.filter(visual => visual.kind === 'image').map(visual => [visual.name, visual.mediaPath]), [
    ['Vector', 'xl/media/vector.svg'], ['Raster', 'xl/media/raster.png'],
  ])
})

test('opens shape picture fills and hyperlinks and preserves them through a cell save', async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const fillPath = 'xl/media/shape-fill.png'
  const svgPath = 'xl/media/shape-fill.svg'
  const vectorOnlyPath = 'xl/media/vector-only.svg'
  const svgBytes = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const href = 'https://example.invalid/help?view=sheet&item=shape'
  const shape = (id, name, imageId, linkId) => `
    <xdr:sp xmlns:r="${relationships.slice(0, -1)}"><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${name}">
      <a:hlinkClick r:id="${linkId}"/></xdr:cNvPr><xdr:cNvSpPr/></xdr:nvSpPr>
      <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="900000" cy="450000"/></a:xfrm>
        <a:prstGeom prst="ellipse"/><a:blipFill><a:blip r:embed="${imageId}">
          <a:alphaModFix amt="60000"/></a:blip><a:stretch><a:fillRect/></a:stretch></a:blipFill></xdr:spPr>
      <xdr:style><a:fillRef idx="1"><a:srgbClr val="112233"/></a:fillRef></xdr:style>
    </xdr:sp>`
  const anchor = (column, object) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${column}</xdr:col>
    <xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="900000" cy="450000"/>${object}<xdr:clientData/></xdr:oneCellAnchor>`
  const group = `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="82" name="Group"/></xdr:nvGrpSpPr>
    <xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="900000" cy="450000"/>
      <a:chOff x="0" y="0"/><a:chExt cx="900000" cy="450000"/></a:xfrm></xdr:grpSpPr>
    ${shape(83, 'Grouped shape', 'fill', 'help')}</xdr:grpSp>`
  const opaque = '<v:cache xmlns:v="urn:vendor"><v:cNvPr name="Vendor" hidden="1"/></v:cache>'
  const standalone = shape(81, 'Filled shape', 'fill', 'help')
    .replace('<xdr:nvSpPr>', opaque + '<xdr:nvSpPr>')
    .replace('<a:hlinkClick', '<d:hlinkClick xmlns:d="' + mainNs + '"')
    .replace('</a:blip>', '<a:extLst><a:ext uri="svg">' +
      '<v:svgBlip xmlns:v="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="vector"/>' +
      '</a:ext></a:extLst></a:blip>')
  const vectorOnly = standalone.replace('Filled shape', 'Vector-only fill').replace('id="81"', 'id="85"')
    .replace('r:embed="fill"', '').replace('r:embed="vector"', 'r:embed="vectorOnly"')
  await appendDrawing(zip, anchor(1, standalone) + anchor(3, group) +
    anchor(5, shape(84, 'External fill', 'external', 'fill')) + anchor(7, vectorOnly))
  zip.file(drawingRels, (await textOf(zip)(drawingRels)).replace('</Relationships>', `
    <Relationship Id="fill" Type="${relationships}image" Target="../media/shape-fill.png"/>
    <Relationship Id="vector" Type="${relationships}image" Target="../media/shape-fill.svg"/>
    <Relationship Id="vectorOnly" Type="${relationships}image" Target="../media/vector-only.svg"/>
    <Relationship Id="external" Type="${relationships}image" Target="https://example.invalid/image.png" TargetMode="External"/>
    <Relationship Id="help" Type="${relationships}hyperlink" Target="${href.replace('&', '&amp;')}" TargetMode="External"/>
  </Relationships>`))
  zip.file(fillPath, Buffer.from(png, 'base64'))
  zip.file(svgPath, svgBytes)
  zip.file(vectorOnlyPath, svgBytes)
  zip.file('[Content_Types].xml', (await textOf(zip)('[Content_Types].xml')).replace('</Types>',
    '<Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/></Types>'))
  const fillProperties = ({ fillColor, fillMediaPath, fillMediaType, opacity, hyperlink }) =>
    ({ fillColor, fillMediaPath, fillMediaType, opacity, hyperlink })
  const expected = { fillColor: 'none', fillMediaPath: fillPath, fillMediaType: 'image/png', opacity: 0.6, hyperlink: href }
  const visuals = await readWorkbookVisuals(textOf(zip), sourceSheet, [], path => Boolean(zip.file(path)))
  const [, filled, grouped, external, vector] = visuals
  assert.deepEqual(fillProperties(filled), expected)
  assert.deepEqual(fillProperties(grouped), expected)
  assert.deepEqual(fillProperties(vector), { ...expected, fillMediaPath: vectorOnlyPath, fillMediaType: 'image/svg+xml' })
  assert.equal(grouped.drawingIndex, undefined)
  assert.deepEqual(fillProperties(external), fillProperties({ fillColor: '#112233' }))

  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-native-shape-fills-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const native = runtime.sheetsNative
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  assert.deepEqual(await native.readMedia(bytes, filled.id), { mediaType: 'image/png', base64: png })
  assert.deepEqual(await native.readMedia(bytes, vector.id), {
    mediaType: 'image/svg+xml', base64: Buffer.from(svgBytes).toString('base64'),
  })
  const request = sheetsSaveRequest('sheet-1', [{ row: 1, column: 0, value: 22, writeValue: true }])
  const saved = (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
  const reopened = (await native.inspect(saved)).visuals.find(visual => visual.id === filled.id)
  assert.deepEqual(fillProperties(reopened), expected)
  const savedZip = await JSZip.loadAsync(saved)
  for (const part of [drawingPath, drawingRels, fillPath]) {
    assert.deepEqual(await savedZip.file(part).async('nodebuffer'), await zip.file(part).async('nodebuffer'))
  }

  const edit = sheetsSaveRequest('sheet-1', [])
  const newLink = 'https://example.invalid/updated'
  edit.visualEdits = [{
    drawingPath, drawingIndex: filled.drawingIndex, altText: 'Updated shape', hyperlink: newLink,
  }]
  const updated = (await native.savePlan(saved, await runtime.sheetsWorkbookPlanner(saved, edit))).bytes
  const { visuals: updatedVisuals } = await native.inspect(updated)
  assert.equal(updatedVisuals.find(visual => visual.id === filled.id).altText, 'Updated shape')
  assert.equal(updatedVisuals.find(visual => visual.id === filled.id).hyperlink, newLink)
  assert.equal(updatedVisuals.find(visual => visual.name === 'Grouped shape').hyperlink, href)
  assert.ok((await textOf(await JSZip.loadAsync(updated))(drawingPath)).includes(opaque))

  const remove = sheetsSaveRequest('sheet-1', [])
  remove.visualEdits = [{ drawingPath, drawingIndex: filled.drawingIndex, remove: true }]
  const removed = (await native.savePlan(updated, await runtime.sheetsWorkbookPlanner(updated, remove))).bytes
  const removedZip = await JSZip.loadAsync(removed)
  const survivingRels = await textOf(removedZip)(drawingRels)
  assert.equal(removedZip.file(svgPath), null)
  assert.ok(!survivingRels.includes('Id="vector"'))
  assert.deepEqual(await removedZip.file(fillPath).async('nodebuffer'), Buffer.from(png, 'base64'))
  assert.ok(!survivingRels.includes(newLink))
  const afterRemoval = (await native.inspect(removed)).visuals
  assert.ok(!afterRemoval.some(visual => visual.name === 'Filled shape'))
  assert.equal(afterRemoval.find(visual => visual.name === 'Grouped shape').hyperlink, href)
})

test('uses GenOffice paint colors for gradient and pattern fills in XLSX drawings', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const art = (body) => `<a:gradFill><a:gsLst>${body}</a:gsLst><a:lin ang="0"/></a:gradFill>`
  const stop = (position, paint) => `<a:gs pos="${position}">${paint}</a:gs>`
  const rgb = (value) => `<a:srgbClr val="${value}"/>`
  const gradient = art(stop('100000', rgb('0000FF')) + stop('0', rgb('FF0000')) +
    stop('50000', rgb('FFFFFF')) + stop('missing', rgb('FFFFFF')))
  const pattern = `<a:pattFill prst="pct50"><a:fgClr>${rgb('FF0000')}</a:fgClr>
    <a:bgClr>${rgb('00FF00')}</a:bgClr></a:pattFill>`
  const shape = (id, fill, line) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${id - 81}</xdr:col>
    <xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="900000" cy="450000"/><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Paint ${id}"/>
      <xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"/>${fill}<a:ln>${line}</a:ln></xdr:spPr></xdr:sp>
    <xdr:clientData/></xdr:oneCellAnchor>`
  await appendDrawing(zip, shape(81, gradient, art(stop('50000', rgb('8899AA')))) +
    shape(82, pattern, '<a:noFill/>') + shape(83, '<a:noFill/>', gradient))
  const chart = await textOf(zip)(chartPath)
  zip.file(chartPath, (chart.includes('xmlns:a=') ? chart : chart.replace('<c:chartSpace ', `<c:chartSpace xmlns:a="${mainNs}" `))
    .replace('</c:plotArea>', `<c:spPr>${gradient}</c:spPr></c:plotArea>`)
    .replace('</c:chartSpace>', `<c:spPr>${pattern}</c:spPr></c:chartSpace>`))

  const [visual, shaded, patterned, outline] = await readWorkbookVisuals(textOf(zip), sourceSheet)
  assert.equal(shaded.fillColor, '#7F007F')
  assert.equal(shaded.lineColor, '#8899AA')
  assert.equal(patterned.fillColor, '#7F7F00')
  assert.equal(patterned.lineColor, 'none')
  assert.equal(outline.fillColor, 'none')
  assert.equal(outline.lineColor, '#7F007F')
  assert.equal(visual.chart.chartAreaFill, '#7F7F00')
  assert.equal(visual.chart.plotAreaFill, '#7F007F')
})

test('applies DrawingML color modifiers to chart and shape paint in document order', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const chart = await textOf(zip)(chartPath)
  zip.file(chartPath, (chart.includes('xmlns:a=') ? chart : chart.replace('<c:chartSpace ', `<c:chartSpace xmlns:a="${mainNs}" `))
    .replace('</c:plotArea>', `<c:spPr><a:solidFill><a:schemeClr val="accent1">
      <a:shade val="50000"/><a:tint val="50000"/>
    </a:schemeClr></a:solidFill></c:spPr></c:plotArea>`)
    .replace('</c:chartSpace>', `<c:spPr><a:solidFill><a:srgbClr val="000000">
      <a:alpha val="50000"/>
    </a:srgbClr></a:solidFill></c:spPr></c:chartSpace>`))
  await appendDrawing(zip, `<xdr:oneCellAnchor>
    <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="900000" cy="450000"/><xdr:sp>
      <xdr:nvSpPr><xdr:cNvPr id="81" name="Toned shape"/><xdr:cNvSpPr/></xdr:nvSpPr>
      <xdr:spPr><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="2080C0">
        <a:lumMod val="50000"/><a:lumOff val="10000"/>
      </a:srgbClr></a:solidFill><a:ln><a:solidFill><a:sysClr val="windowText"/></a:solidFill></a:ln></xdr:spPr>
      <xdr:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:solidFill>
        <a:sysClr val="window" lastClr="446688"><a:shade val="50000"/></a:sysClr>
      </a:solidFill></a:rPr><a:t>System color</a:t></a:r></a:p></xdr:txBody>
    </xdr:sp><xdr:clientData/>
  </xdr:oneCellAnchor>`)
  const [visual, shape] = await readWorkbookVisuals(textOf(zip), sourceSheet,
    ['#FFFFFF', '#000000', '#EEEEEE', '#111111', '#9F0033'])
  assert.equal(visual.chart.chartAreaFill, '#808080')
  assert.equal(visual.chart.plotAreaFill, '#A7808C')
  assert.equal(shape.fillColor, '#2A5A7A')
  assert.equal(shape.lineColor, '#000000')
  assert.equal(shape.paragraphs[0].runs[0].color, '#223344')
})

test('preserves theme-referenced shape gradients through Web saves', async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const workbookRels = 'xl/_rels/workbook.xml.rels'
  zip.file(workbookRels, (await textOf(zip)(workbookRels)).replace('</Relationships>',
    `<Relationship Id="theme" Type="${relationships}theme" Target="theme/shape-paint.xml"/></Relationships>`))
  zip.file('[Content_Types].xml', (await textOf(zip)('[Content_Types].xml')).replace('</Types>',
    '<Override PartName="/xl/theme/shape-paint.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'))
  const slots = 'lt1 dk1 lt2 dk2 accent1 accent2 accent3 accent4 accent5 accent6 hlink folHlink'.split(' ')
  const colors = slots.map(slot => slot === 'accent2' ? '#00CC00' : '#042233')
  const palette = slots.map((slot, index) => `<p:${slot}><p:srgbClr val="${colors[index].slice(1)}"/></p:${slot}>`).join('')
  zip.file('xl/theme/shape-paint.xml', `<p:theme xmlns:p="${mainNs}"><p:themeElements>
    <p:clrScheme name="Fixture">${palette}</p:clrScheme><p:fmtScheme name="Fixture">
      <p:fillStyleLst><p:solidFill><p:schemeClr val="phClr"/></p:solidFill>
        <p:gradFill><p:gsLst>
          <p:gs pos="0"><p:schemeClr val="phClr"/></p:gs>
          <p:gs pos="25000"><p:srgbClr val="CB6633"><p:shade val="50000"/></p:srgbClr></p:gs>
          <p:gs pos="50000"><p:schemeClr val="phClr"><p:satMod val="0"/></p:schemeClr></p:gs>
          <p:gs pos="75000"><p:schemeClr val="accent2"/></p:gs>
          <p:gs pos="90000"><p:sysClr val="windowText"/></p:gs>
          <p:gs pos="100000"><p:schemeClr val="phClr"><p:tint val="50000"/></p:schemeClr></p:gs>
        </p:gsLst><p:lin ang="16200000"/></p:gradFill>
        <p:gradFill><p:gsLst>
          <p:gs pos="0"><p:srgbClr val="0000AA"/></p:gs>
          <p:gs pos="100000"><p:srgbClr val="AA0000"/></p:gs>
        </p:gsLst></p:gradFill>
      </p:fillStyleLst>
      <p:bgFillStyleLst>
        <p:solidFill><p:srgbClr val="008800"/></p:solidFill>
        <p:gradFill><p:gsLst>
          <p:gs pos="0"><p:schemeClr val="phClr"/></p:gs>
          <p:gs pos="100000"><p:srgbClr val="AA0000"/></p:gs>
        </p:gsLst></p:gradFill>
        <p:pattFill prst="pct50"><p:fgClr><p:schemeClr val="phClr"/></p:fgClr>
          <p:bgClr><p:schemeClr val="accent2"/></p:bgClr></p:pattFill>
        <p:noFill/>
      </p:bgFillStyleLst>
    </p:fmtScheme>
  </p:themeElements></p:theme>`)
  const shape = (id, index, fill = '', reference = '<a:schemeClr val="accent1"/>') => `<xdr:oneCellAnchor>
    <xdr:from><xdr:col>${id - 81}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="900000" cy="450000"/><xdr:sp>
      <xdr:nvSpPr><xdr:cNvPr id="${id}" name="Theme paint ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr>
      <xdr:spPr><a:prstGeom prst="rect"/>${fill}</xdr:spPr>
      <xdr:style><a:fillRef idx="${index}">${reference}</a:fillRef></xdr:style>
    </xdr:sp><xdr:clientData/>
  </xdr:oneCellAnchor>`
  await appendDrawing(zip, shape(81, 2) + shape(82, 2, '<a:noFill/>') +
    shape(83, 2, '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>') + shape(84, 1) +
    shape(85, 3, '', '') + shape(86, 2, '', '<a:srgbClr val="FF0000"/>') +
    shape(87, 1001) + shape(88, 1002) + shape(89, 1003) + shape(90, 1004) +
    shape(91, 1000) + shape(92, 1002, '<a:solidFill><a:srgbClr val="010203"/></a:solidFill>'))
  const styles = visuals => visuals.filter(visual => visual.name?.startsWith('Theme paint'))
  const themeShapes = styles(await readWorkbookVisuals(textOf(zip), sourceSheet, colors))
  const [gradient, transparent, solid, firstStyle, fixedGradient, rgbReference,
    backgroundSolid, backgroundGradient, backgroundPattern, backgroundNoFill, reserved, override] = themeShapes
  const expected = { angle: 270, stops: [
    { position: 0, color: '#042233' },
    { position: 0.25, color: '#66331A' },
    { position: 0.5, color: '#1C1C1C' },
    { position: 0.75, color: '#00CC00' },
    { position: 0.9, color: '#000000' },
    { position: 1, color: '#829199' },
  ] }
  assert.deepEqual(gradient.fillGradient, expected)
  assert.equal(gradient.fillColor, '#042233')
  assert.equal(transparent.fillColor, 'none')
  assert.equal(solid.fillColor, '#FF0000')
  assert.equal(firstStyle.fillColor, '#042233')
  for (const visual of [transparent, solid, firstStyle]) assert.equal(visual.fillGradient, undefined)
  assert.deepEqual(fixedGradient.fillGradient, { angle: 90, stops: [
    { position: 0, color: '#0000AA' },
    { position: 1, color: '#AA0000' },
  ] })
  assert.equal(rgbReference.fillGradient.stops[0].color, '#FF0000')
  assert.equal(rgbReference.fillGradient.stops[1].color, '#66331A')
  assert.equal(backgroundSolid.fillColor, '#008800')
  assert.deepEqual(backgroundGradient.fillGradient, { angle: 90, stops: [
    { position: 0, color: '#042233' },
    { position: 1, color: '#AA0000' },
  ] })
  assert.equal(backgroundPattern.fillColor, '#027719')
  assert.equal(backgroundNoFill.fillColor, 'none')
  assert.equal(reserved.fillColor, 'none')
  assert.equal(override.fillColor, '#010203')
  assert.equal(override.fillGradient, undefined)

  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-theme-gradient-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const inspected = await runtime.sheetsNative.inspect(bytes)
  const paints = visuals => styles(visuals).map(({ fillColor, fillGradient }) => ({ fillColor, fillGradient }))
  const expectedPaints = paints(themeShapes)
  assert.deepEqual(paints(inspected.visuals), expectedPaints)
  const request = sheetsSaveRequest(inspected.sheets[0].id, [{ row: 0, column: 0, value: 42, writeValue: true }])
  const saved = (await runtime.sheetsNative.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
  assert.deepEqual(paints((await runtime.sheetsNative.inspect(saved)).visuals), expectedPaints)
})

test('opens XLSX freeform shapes with scaled paths and preserves their original geometry on save', async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const pt = (x, y) => `<a:pt x="${x}" y="${y}"/>`
  const move = (x, y) => `<a:moveTo>${pt(x, y)}</a:moveTo>`
  const line = (x, y) => `<a:lnTo>${pt(x, y)}</a:lnTo>`
  const openPath = `<a:path w="200" h="0" fill="none">${move(0, 0)}${line(200, 0)}</a:path>`
  const filledPath = `<a:path w="100" h="100">${move(0, 0)}${line(40, 0)}
    <a:quadBezTo>${pt(80, 0)}${pt(80, 40)}</a:quadBezTo>
    <a:cubicBezTo>${pt(80, 60)}${pt(60, 100)}${pt(0, 100)}</a:cubicBezTo><a:close/></a:path>`
  const mixedPath = `<a:path w="200" h="50" fill="none">${move(20, 5)}${line(180, 5)}</a:path>`
  const arcPath = `<a:path w="100" h="100">${move(0, 0)}<a:arcTo wR="10" hR="10" stAng="0" swAng="5400000"/></a:path>`
  const shape = (id, name, paths, text = '') => `<xdr:oneCellAnchor><xdr:from><xdr:col>${id - 81}</xdr:col>
    <xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="900000" cy="450000"/><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${name}"/>
      <xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:custGeom><a:avLst/><a:pathLst>${paths}</a:pathLst></a:custGeom>
      <a:solidFill><a:srgbClr val="112233"/></a:solidFill></xdr:spPr>${text}</xdr:sp><xdr:clientData/></xdr:oneCellAnchor>`
  const paragraph = '<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Arc text</a:t></a:r></a:p></xdr:txBody>'
  await appendDrawing(zip, shape(81, 'Mixed paths', filledPath + mixedPath) + shape(82, 'Open path', openPath) +
    shape(83, 'Arc fallback', arcPath, paragraph))
  const filled = 'M 0 0 L 40 0 Q 80 0 80 40 C 80 60 60 100 0 100 Z'
  const check = ([chart, mixed, open, arc]) => {
    assert.equal(chart.kind, 'chart')
    assert.equal(mixed.name, 'Mixed paths')
    assert.equal(mixed.drawingIndex, 1)
    assert.deepEqual(mixed.customPath, { width: 100, height: 100, d: `${filled} M 10 10 L 90 10`, fillD: filled })
    assert.deepEqual(open.customPath, { width: 200, height: 1, d: 'M 0 0 L 200 0', strokeOnly: true })
    assert.equal(arc.customPath, undefined)
    assert.equal(arc.text, 'Arc text')
  }
  check(await readWorkbookVisuals(textOf(zip), sourceSheet))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-native-freeform-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const native = runtime.sheetsNative
  const request = sheetsSaveRequest('sheet-1', [{ row: 1, column: 0, value: 22, writeValue: true }])
  const saved = (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
  check(workbookFileSchema.shape.visuals.parse((await native.inspect(saved)).visuals))
  assert.equal(await textOf(await JSZip.loadAsync(saved))(drawingPath), await textOf(zip)(drawingPath))
})

test('opens a native XLSX text box and edits its paint at the original drawing index', async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const opaque = '<v:solidFill xmlns:v="urn:vendor"><a:srgbClr val="555555"/></v:solidFill>'
  await appendDrawing(zip, `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="10000" cy="10000"/><xdr:sp/></xdr:absoluteAnchor>
    <xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
      <xdr:ext cx="952500" cy="476250"/>
      <xdr:sp xmlns:d="${mainNs}"><xdr:nvSpPr><xdr:cNvPr id="81" name="Audit text box" descr="Quarterly &amp; annual"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr>
        <xdr:spPr>${opaque}<d:prstGeom prst="rect"><d:avLst/></d:prstGeom><d:solidFill><d:srgbClr val="FF0000"/></d:solidFill>
          <d:ln w="25400" cap="rnd"><d:solidFill><d:srgbClr val="223344"/></d:solidFill><d:prstDash val="dash"/></d:ln></xdr:spPr>
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
  request.visualEdits = [{ drawingPath: shape.drawingPath, drawingIndex: shape.drawingIndex, fillColor: '#00FF00', lineColor: '#123456' }]
  const plan = await runtime.sheetsWorkbookPlanner(bytes, request)
  const output = (await runtime.sheetsNative.savePlan(bytes, plan)).bytes
  const reopened = (await runtime.sheetsNative.inspect(output, undefined, true)).visuals
  assert.deepEqual(reopened, [visuals[0], { ...shape, fillColor: '#00FF00', lineColor: '#123456' }])
  const savedDrawing = await textOf(await JSZip.loadAsync(output))(drawingPath)
  assert.ok(savedDrawing.includes(opaque))
  assert.match(savedDrawing, /<xdr:cNvPr id="81" name="Audit text box"/)
})

test('saves layer order across reorder and removal commands', { timeout: 120_000 }, async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const names = ['Layer A', 'Layer B', 'Layer C', 'Layer D']
  const layers = names.map((name, index) => `<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>3</xdr:row></xdr:from>
    <xdr:ext cx="952500" cy="476250"/><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${100 + index}" name="${name}"/></xdr:nvSpPr>
    <xdr:spPr><a:prstGeom prst="rect"/></xdr:spPr></xdr:sp><xdr:clientData/></xdr:oneCellAnchor>`)
  const comment = '<!-- Keep drawing extension slot -->'
  await appendDrawing(zip, layers.join(comment))
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-layer-order-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const original = (await runtime.sheetsNative.inspect(source)).visuals.filter(({ name }) => names.includes(name))
  const recorded = changedPositions(names, reorderZ(names, 'Layer A', 'front'))
  recorded.delete('Layer B')
  const before = ['Layer C', 'Layer D', 'Layer A']
  for (const [name, index] of changedPositions(before, reorderZ(before, 'Layer D', 'front'), name => recorded.get(name))) {
    recorded.set(name, index)
  }
  const request = sheetsSaveRequest(original[0].sheetId, [])
  request.visualEdits = original.map(({ name, drawingIndex }) => ({
    drawingPath, drawingIndex, ...(name === 'Layer B' ? { remove: true } : { zIndex: recorded.get(name) }),
  }))
  const plan = await runtime.sheetsWorkbookPlanner(source, request)
  const { bytes } = await runtime.sheetsNative.savePlan(source, plan)
  const reordered = (await runtime.sheetsNative.inspect(bytes)).visuals.filter(({ name }) => names.includes(name))
  assert.deepEqual(reordered.map(({ name }) => name), ['Layer C', 'Layer A', 'Layer D'])
  assert.equal((await textOf(await JSZip.loadAsync(bytes))(drawingPath)).split(comment).length, 4)
})

test('round-trips formatted plot labels while preserving series point overrides', async t => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  const pointOverrides = '<c:dLbls><c:dLbl><c:idx val="0"/><c:showVal/></c:dLbl>' +
    '<c:dLbl><c:idx val="1"/><c:delete/><c:showVal val="1"/></c:dLbl>' +
    '<c:numFmt formatCode="0.00" sourceLinked="0"/><c:showVal val="0"/></c:dLbls>'
  const chart = await textOf(zip)(chartPath)
  zip.file(chartPath, chart.replace('<c:val>', pointOverrides + '<c:val>')
    .replace('</c:ser>', `</c:ser>
      <c:dLbls>
        <c:dLbl><c:idx val="0"/><c:numFmt formatCode="0.000" sourceLinked="0"/></c:dLbl>
        <c:numFmt formatCode="0.0" sourceLinked="0"/><c:showVal val="0"/>
      </c:dLbls>`))
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-plot-labels-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const inspect = async bytes => (await runtime.sheetsNative.inspect(bytes)).visuals[0].chart
  const save = async (bytes, chartEdit) => {
    const request = sheetsSaveRequest('sheet-1', [])
    request.chartEdits = [{ chartPath, ...chartEdit }]
    return (await runtime.sheetsNative.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
  }
  const original = await inspect(source)
  assert.equal(original.dataLabels, 'none')
  assert.equal(original.dataLabelFormat, '0.0')
  assert.deepEqual(original.series[0].pointLabels.map(({ index, showVal }) => [index, showVal]), [[0, true], [1, false]])
  const edited = await save(source, { dataLabelPosition: 'inside-end', dataLabelFormat: '#,##0' })
  const editedChart = await inspect(edited)
  assert.equal(editedChart.dataLabelFormat, '#,##0')
  assert.equal(editedChart.dataLabelPosition, 'inside-end')
  const editedXml = await textOf(await JSZip.loadAsync(edited))(chartPath)
  assert.ok(editedXml.includes('formatCode="0.000"'))
  assert.equal(editedXml.match(/<c:dLbls[>\s]/g).length, 2)
  const cleared = await save(edited, { dataLabels: 'none' })
  assert.deepEqual((await inspect(cleared)).series[0].pointLabels, original.series[0].pointLabels)
  const clearedXml = await textOf(await JSZip.loadAsync(cleared))(chartPath)
  assert.ok(clearedXml.includes(pointOverrides))
  assert.equal(clearedXml.match(/<c:dLbls[>\s]/g).length, 1)
})

test('rotates nested groups and shapes in the parent coordinate space', async () => {
  const zip = await JSZip.loadAsync(await readFile(fixture))
  await appendDrawing(zip, `<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="400000" cy="200000"/><xdr:grpSp>
      <xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="400000" cy="200000"/><a:chOff x="0" y="0"/><a:chExt cx="200000" cy="200000"/></a:xfrm></xdr:grpSpPr>
      <xdr:grpSp>
        <xdr:grpSpPr><a:xfrm rot="5400000" flipV="true"><a:off x="100000" y="50000"/><a:ext cx="80000" cy="40000"/><a:chOff x="0" y="0"/><a:chExt cx="80000" cy="40000"/></a:xfrm></xdr:grpSpPr>
        <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="91" name="Rotated group child"/></xdr:nvSpPr>
          <xdr:spPr><a:xfrm><a:off x="10000" y="5000"/><a:ext cx="20000" cy="10000"/></a:xfrm><a:prstGeom prst="rightArrow"/></xdr:spPr>
        </xdr:sp>
      </xdr:grpSp>
      <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="92" name="Rotated shape child"/></xdr:nvSpPr>
        <xdr:spPr><a:xfrm rot="5400000" flipV="true"><a:off x="10000" y="5000"/><a:ext cx="20000" cy="10000"/></a:xfrm><a:prstGeom prst="rightArrow"/></xdr:spPr>
      </xdr:sp>
    </xdr:grpSp><xdr:clientData/></xdr:oneCellAnchor>`)
  const visuals = workbookFileSchema.shape.visuals.parse(await readWorkbookVisuals(textOf(zip), sourceSheet))
  const shape = visuals.find(visual => visual.name === 'Rotated group child')
  assert.ok(shape)
  assert.deepEqual(shape.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 40000, fromColumnOffset: 250000,
    toRow: 2, toColumn: 1, toRowOffset: 60000, toColumnOffset: 270000,
  })
  assert.deepEqual(shape.groupTransform, { matrix: [0, 1, 2, 0], width: 20000, height: 10000 })
  const rotatedShape = visuals.find(visual => visual.name === 'Rotated shape child')
  assert.deepEqual(rotatedShape?.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 0, fromColumnOffset: 30000,
    toRow: 2, toColumn: 1, toRowOffset: 20000, toColumnOffset: 50000,
  })
  assert.deepEqual(rotatedShape.groupTransform, shape.groupTransform)
  assert.equal(rotatedShape.rotation, undefined)
})

test('places nested group shapes and straight connectors with read-only child locators', async t => {
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
        <xdr:pic xmlns:r="${relationships.slice(0, -1)}">
          <xdr:nvPicPr><xdr:cNvPr id="95" name="Grouped logo" descr="Group artwork"/></xdr:nvPicPr>
          <xdr:blipFill><a:blip><a:alphaModFix amt="60000"/><a:extLst><a:ext uri="svg">
            <s:svgBlip xmlns:s="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="vector"/>
          </a:ext></a:extLst></a:blip><a:srcRect l="10000"/></xdr:blipFill>
          <xdr:spPr><a:xfrm rot="5400000" flipV="1"><a:off x="65000" y="65000"/><a:ext cx="20000" cy="10000"/></a:xfrm></xdr:spPr>
        </xdr:pic>
        <xdr:graphicFrame xmlns:r="${relationships.slice(0, -1)}" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
            xmlns:f="urn:foreign">
          <xdr:nvGraphicFramePr><xdr:cNvPr id="96" name="Grouped chart"/></xdr:nvGraphicFramePr>
          <xdr:xfrm><a:off x="60000" y="80000"/><a:ext cx="20000" cy="15000"/></xdr:xfrm>
          <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <f:chart r:id="foreign"/><c:chart r:id="groupChart"/>
          </a:graphicData></a:graphic>
        </xdr:graphicFrame>
      </xdr:grpSp>
    </xdr:grpSp><xdr:clientData/></xdr:oneCellAnchor>`)
  const mediaPath = 'xl/media/group.svg'
  const nestedChartPath = 'xl/charts/group.xml'
  zip.file(nestedChartPath, await textOf(zip)(chartPath))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
  zip.file(mediaPath, svg)
  zip.file(drawingRels, (await textOf(zip)(drawingRels)).replace('</Relationships>',
    `<Relationship Id="vector" Type="${relationships}image" Target="../media/group.svg"/>` +
    `<Relationship Id="groupChart" Type="${relationships}chart" Target="../charts/group.xml"/>` +
    `<Relationship Id="foreign" Type="${relationships}chart" Target="../charts/chart1.xml"/></Relationships>`))
  zip.file('[Content_Types].xml', (await textOf(zip)('[Content_Types].xml')).replace('</Types>',
    '<Default Extension="svg" ContentType="image/svg+xml"/>' +
    `<Override PartName="/${nestedChartPath}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`))
  const theme = ['#FFFFFF', '#000000', '#EEEEEE', '#111111', '#4472C4']
  const visuals = workbookFileSchema.shape.visuals.parse(await readWorkbookVisuals(textOf(zip), sourceSheet, theme))
  assert.deepEqual(visuals.map(({ id }) => id), ['visual-1', 'visual-2-1', 'visual-2-2', 'visual-2-3', 'visual-2-4'])
  const [standalone, ellipse, line, picture, chart] = visuals
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
  assert.equal(picture.kind, 'image')
  assert.equal(picture.name, 'Grouped logo')
  assert.equal(picture.altText, 'Group artwork')
  assert.equal(picture.drawingIndex, undefined)
  assert.equal(picture.mediaPath, mediaPath)
  assert.deepEqual(picture.groupTransform, { matrix: [0, 1, 2, 0], width: 20000, height: 10000 })
  assert.equal(picture.opacity, 0.6)
  assert.deepEqual(picture.crop, { left: 0.1, top: 0, right: 0, bottom: 0 })
  assert.deepEqual(picture.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 82000, fromColumnOffset: 241000,
    toRow: 2, toColumn: 1, toRowOffset: 102000, toColumnOffset: 261000,
  })

  assert.equal(chart.kind, 'chart')
  assert.equal(chart.name, 'Grouped chart')
  assert.equal(chart.drawingIndex, undefined)
  assert.equal(chart.chartPath, nestedChartPath)
  assert.deepEqual(chart.chart.series, standalone.chart.series)
  assert.deepEqual(chart.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 102000, fromColumnOffset: 221000,
    toRow: 2, toColumn: 1, toRowOffset: 117000, toColumnOffset: 261000,
  })

  const originalDrawing = await textOf(zip)(drawingPath)
  zip.file(drawingPath, originalDrawing
    .replace('<a:xfrm><a:off x="0" y="0"/><a:ext cx="400000"', '<a:xfrm flipH="1"><a:off x="0" y="0"/><a:ext cx="400000"')
    .replace('<a:xfrm><a:off x="200000" y="240000"/>', '<a:xfrm flipH="true" flipV="1"><a:off x="200000" y="240000"/>')
    .replace('<a:xfrm><a:off x="125000" y="210000"/>', '<a:xfrm rot="2700000"><a:off x="125000" y="210000"/>'))
  const reflected = workbookFileSchema.shape.visuals.parse(await readWorkbookVisuals(textOf(zip), sourceSheet, theme))
  assert.deepEqual(reflected.map(({ id }) => id), visuals.map(({ id }) => id))
  const [, reflectedEllipse, reflectedLine, reflectedPicture, reflectedChart] = reflected
  assert.deepEqual(reflectedEllipse.anchor, { ...ellipse.anchor, fromColumnOffset: 251000, toColumnOffset: 351000 })
  assert.deepEqual([reflectedEllipse.flipH, reflectedEllipse.flipV], [true, false])
  assert.deepEqual([reflectedEllipse.rotation, reflectedEllipse.frameWidth, reflectedEllipse.frameHeight], [-45, 100000, 50000])
  assert.deepEqual(reflectedLine.anchor, {
    ...line.anchor, fromColumnOffset: 141000, toColumnOffset: 181000, fromRowOffset: 172000, toRowOffset: 172000,
  })
  assert.deepEqual([reflectedLine.flipH, reflectedLine.flipV], [true, true])
  assert.deepEqual(reflectedPicture.anchor, {
    ...picture.anchor, fromColumnOffset: 141000, toColumnOffset: 161000, fromRowOffset: 162000, toRowOffset: 182000,
  })
  assert.deepEqual(reflectedPicture.groupTransform, { ...picture.groupTransform, matrix: [0, -1, 2, 0] })
  assert.deepEqual(reflectedChart.anchor, {
    ...chart.anchor, fromColumnOffset: 121000, toColumnOffset: 161000, fromRowOffset: 147000, toRowOffset: 162000,
  })
  assert.deepEqual([reflectedChart.flipH, reflectedChart.flipV], [false, true])

  const reflectedDrawing = await textOf(zip)(drawingPath)
  zip.file(drawingPath, reflectedDrawing.replace(
    '<a:xfrm flipH="1"><a:off x="0" y="0"/><a:ext cx="400000"',
    '<a:xfrm flipH="1" rot="1800000"><a:off x="0" y="0"/><a:ext cx="400000"',
  ))
  const rotated = workbookFileSchema.shape.visuals.parse(await readWorkbookVisuals(textOf(zip), sourceSheet, theme))
  const rotatedChart = rotated.find(visual => visual.id === chart.id)
  const rotatedPicture = rotated.find(visual => visual.id === picture.id)
  assert.ok(rotatedChart?.groupTransform)
  assert.ok(rotatedPicture?.groupTransform)
  assert.notEqual(rotatedChart.groupTransform.matrix[1], 0)

  // The linearly scaled, reflected parent has no rotation of its own.
  zip.file(drawingPath, reflectedDrawing
    .replace('<a:chExt cx="50000" cy="100000"/>', '<a:chExt cx="50000" cy="50000"/>')
    .replace('<xdr:xfrm><a:off x="60000" y="80000"/>', '<xdr:xfrm rot="5400000" flipH="1"><a:off x="60000" y="80000"/>'))
  const reoriented = workbookFileSchema.shape.visuals.parse(
    JSON.parse(JSON.stringify(await readWorkbookVisuals(textOf(zip), sourceSheet, theme))),
  )
  const reorientedChart = reoriented.find(visual => visual.id === chart.id)
  const reorientedPicture = reoriented.find(visual => visual.id === picture.id)
  assert.deepEqual(reorientedChart?.groupTransform, { matrix: [0, 2, -2, 0], width: 20000, height: 15000 })
  assert.deepEqual(reorientedChart.anchor, {
    fromRow: 2, fromColumn: 1, fromRowOffset: 107000, fromColumnOffset: 126000,
    toRow: 2, toColumn: 1, toRowOffset: 147000, toColumnOffset: 156000,
  })

  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-web-group-image-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess', DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const request = sheetsSaveRequest(picture.sheetId, [{ row: 1, column: 0, value: 22, writeValue: true }])
  request.chartEdits = [{ chartPath: chart.chartPath, title: 'Edited chart in group' }]
  const saved = (await runtime.sheetsNative.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
  const savedVisuals = (await runtime.sheetsNative.inspect(saved)).visuals
  const savedChart = savedVisuals.find(visual => visual.id === chart.id)
  assert.equal(savedChart.chart.title, 'Edited chart in group')
  assert.deepEqual(savedChart.anchor, reorientedChart.anchor)
  assert.deepEqual(savedChart.groupTransform, reorientedChart.groupTransform)
  assert.equal(savedVisuals.find(visual => visual.id === standalone.id).chart.title, standalone.chart.title)
  const savedPicture = savedVisuals.find(visual => visual.id === picture.id)
  assert.deepEqual(JSON.parse(JSON.stringify(savedPicture)), JSON.parse(JSON.stringify(reorientedPicture)))
  assert.deepEqual(await runtime.sheetsNative.readMedia(saved, picture.id), {
    mediaType: 'image/svg+xml', base64: Buffer.from(svg).toString('base64'),
  })
})
