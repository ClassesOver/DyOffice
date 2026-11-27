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

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships'
const worksheetPath = 'xl/worksheets/sheet1.xml'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT4sAAAAASUVORK5CYII=', 'base64')
const relationship = (id, kind, target, extra = '') =>
  `<Relationship Id="${id}" Type="${office}/${kind}" Target="${target}"${extra}/>`
const relationships = (...entries) =>
  `<Relationships xmlns="${packageRels}">${entries.join('')}</Relationships>`
const vml = (body) =>
  `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">${body}</xml>`
const marker = (tag, col, row) => `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:row>${row}</xdr:row></xdr:${tag}>`

test('Web XLSX reads legacy styles and images without changing their saved parts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-legacy-parts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_SANDBOX_MODE: 'subprocess',
    DYOFFICE_DEPLOYMENT_ID: randomUUID(),
    DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
  }, { enabled: true })
  t.after(() => runtime.close())
  const native = runtime.sheetsNative
  const zip = await JSZip.loadAsync(await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)))
  const stylesPath = 'xl/parts/styles one.xml'
  const stringsPath = 'xl/parts/strings.xml'
  const themePath = 'xl/parts/active theme.xml'
  const workbookRelsPath = 'xl/_rels/workbook.xml.rels'
  const workbookRels = await zip.file(workbookRelsPath).async('string')
  zip.file(workbookRelsPath, workbookRels.replace('Target="styles.xml"', "Target='parts/styles%20one.xml'")
    .replace('</Relationships>',
      relationship('sst', 'sharedStrings', 'parts/strings.xml') +
      relationship('theme', 'theme', 'parts/active%20theme.xml') + '</Relationships>'))
  zip.file(stringsPath, '<s:sst xmlns:s="http://purl.oclc.org/ooxml/spreadsheetml/main">' +
    '<s:si/><s:si><s:r><s:rPr><s:b/></s:rPr><s:t>Linked</s:t></s:r>' +
    '<s:r><s:t xml:space="preserve"> text</s:t></s:r></s:si></s:sst>')
  zip.file('xl/sharedStrings.xml', `<sst xmlns="${main}"><si><t>Unrelated text</t></si></sst>`)
  const colorSlots = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4',
    'accent5', 'accent6', 'hlink', 'folHlink']
  const theme = (color, major, minor) =>
    '<d:theme xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<d:themeElements><d:clrScheme name="Test">' +
    colorSlots.map((slot) => `<d:${slot}><d:srgbClr val="${color}"/></d:${slot}>`).join('') +
    '</d:clrScheme><d:fontScheme name="Test">' +
    `<d:majorFont><d:latin typeface="${major}"/></d:majorFont>` +
    `<d:minorFont><d:latin typeface="${minor}"/></d:minorFont>` +
    '</d:fontScheme></d:themeElements></d:theme>'
  zip.file(themePath, theme('224466', 'Georgia', 'Arial'))
  zip.file('xl/theme/theme1.xml', theme('999999', 'Unused Major', 'Unused Minor'))
  const formats = [5, 14, 20, 44, 46, 49, 58, 164]
  zip.file(stylesPath, `<styleSheet xmlns="${main}">
    <numFmts count="1"><numFmt numFmtId="164" formatCode="00.000"/></numFmts>
    <fonts count="2"><font><color indexed="1"/></font><font><color indexed="2"/></font></fonts>
    <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
    <cellXfs count="${formats.length}">${formats.map((id) => `<xf numFmtId="${id}" fontId="${id === 164 ? 1 : 0}"/>`).join('')}</cellXfs>
    <colors><indexedColors><rgbColor rgb="FF010203"/><rgbColor rgb="FF223344"/></indexedColors></colors>
  </styleSheet>`)
  zip.file(worksheetPath, `<worksheet xmlns="${main}" xmlns:r="${office}" xmlns:xdr="${drawing}">
    <sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData>
    <drawing r:id="drawing"/><legacyDrawing r:id="oleVml"/><legacyDrawingHF r:id="headerVml"/>
    <oleObjects>
      <oleObject progId="Package" shapeId="1025" r:id="embed"/>
      <oleObject progId="Word.Document.12" shapeId="1026" r:id="embed">
        <objectPr r:id="preview"><anchor>${marker('from', 1, 1)}${marker('to', 3, 3)}</anchor></objectPr>
      </oleObject>
    </oleObjects>
    <headerFooter differentOddEven="1"><oddHeader>&amp;L&amp;G</oddHeader><evenFooter>&amp;R&amp;G</evenFooter></headerFooter>
  </worksheet>`)
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', relationships(
    relationship('drawing', 'drawing', '../drawings/drawing1.xml'),
    relationship('oleVml', 'vmlDrawing', '../drawings/ole.vml'),
    relationship('headerVml', 'vmlDrawing', '../drawings/header.vml'),
    relationship('embed', 'oleObject', '../embeddings/object.bin'),
    relationship('preview', 'image', '../media/ole.emf'),
  ))
  zip.file('xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="${drawing}">
    <xdr:twoCellAnchor>${marker('from', 1, 1)}${marker('to', 3, 3)}
      <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="1026" name="OLE fallback"/></xdr:nvSpPr></xdr:sp>
    </xdr:twoCellAnchor>
  </xdr:wsDr>`)
  zip.file('xl/drawings/_rels/drawing1.xml.rels', relationships())
  zip.file('xl/drawings/header.vml', vml(`
    <v:shape id="LH" style="width:1in;height:48px"><v:imagedata o:relid="logo"/></v:shape>
    <v:shape id="RFEVEN" style="width:2in;height:36pt"><v:imagedata o:relid="remote"/></v:shape>
  `))
  zip.file('xl/drawings/_rels/header.vml.rels', relationships(
    relationship('logo', 'image', '../media/fixture.png'),
    relationship('remote', 'image', 'https://example.invalid/image.png', ' TargetMode="External"'),
  ))
  zip.file('xl/drawings/ole.vml', vml(`
    <v:shape id="_x0000_s1025" strokecolor="#224466" fillcolor="#CCDDFF">
      <v:imagedata o:relid="logo"/><x:ClientData ObjectType="Pict"><x:Anchor>0,0,4,0,5,1,10,1</x:Anchor></x:ClientData>
    </v:shape>
  `))
  zip.file('xl/drawings/_rels/ole.vml.rels', relationships(relationship('logo', 'image', '../media/fixture.png')))
  zip.file('xl/media/fixture.png', png)
  zip.file('xl/media/ole.emf', 'synthetic metafile bytes')
  zip.file('xl/embeddings/object.bin', 'inert embedded object')
  const contentTypes = await zip.file('[Content_Types].xml').async('string')
  zip.file('[Content_Types].xml', contentTypes.replace('</Types>',
    '<Override PartName="/xl/parts/styles%20one.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/parts/strings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/parts/active%20theme.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>'))
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const range = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }
  const metadata = await native.inspect(bytes)

  await t.test('resolves the built-in formats used by the English Web reader', () => {
    assert.deepEqual(metadata.styles.map(({ numberFormat }) => numberFormat), [
      '"$"#,##0_);("$"#,##0)', 'm/d/yyyy', 'hh:mm',
      String.raw`_("$"* #,##0.00_);_("$"* \(#,##0.00\);_("$"* "-"??_);_(@_)`,
      '[h]:mm:ss', '@', 'm/d/yyyy', '00.000',
    ])
  })

  await t.test('uses the nested indexed palette and falls back for undefined indices', () => {
    assert.equal(metadata.styles[0].fontColor, '#223344')
    assert.equal(metadata.styles.at(-1).fontColor, '#FF0000')
  })

  await t.test('reads linked strings and saves formatting in the linked stylesheet', async () => {
    const { cells } = await native.readRange(bytes, 'Acceptance', { ...range, startColumn: 1, endColumn: 1 })
    assert.equal(cells[0].value, 'Linked text')
    assert.deepEqual(cells[0].rich.map(({ text, bold }) => [text, bold]), [['Linked', true], [' text', false]])
    const request = sheetsSaveRequest('sheet-1', [
      { row: 0, column: 0, writeValue: false, value: null, style: { bold: true } },
    ])
    const result = await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))
    const saved = await JSZip.loadAsync(result.bytes)
    assert.equal(await saved.file('xl/styles.xml').async('string'), await zip.file('xl/styles.xml').async('string'))
    assert.notEqual(await saved.file(stylesPath).async('string'), await zip.file(stylesPath).async('string'))
    assert.equal(await saved.file(stringsPath).async('string'), await zip.file(stringsPath).async('string'))
    assert.ok((await native.inspect(result.bytes)).styles.some((style) => style.bold))
  })

  await t.test('reads and rewrites the linked theme while preserving an orphan theme', async () => {
    assert.deepEqual(metadata.themeFonts, { major: 'Georgia', minor: 'Arial' })
    assert.equal(metadata.themeColors[4], '#224466')
    const request = {
      ...sheetsSaveRequest('sheet-1', []),
      themeState: {
        colors: { name: '2$ Palette', values: Array(12).fill('#123456') },
        fonts: { name: 'Alternate Fonts', major: 'Verdana', minor: 'Tahoma' },
      },
    }
    const result = await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))
    const saved = await JSZip.loadAsync(result.bytes)
    assert.equal(await saved.file('xl/theme/theme1.xml').async('string'),
      await zip.file('xl/theme/theme1.xml').async('string'))
    assert.match(await saved.file(themePath).async('string'), /<d:clrScheme name="2\$ Palette">/)
    const updated = await native.inspect(result.bytes)
    assert.deepEqual(updated.themeFonts, { major: 'Verdana', minor: 'Tahoma' })
    assert.equal(updated.themeColors[4], '#123456')
  })

  await t.test('loads the internal header image by slot without exposing external relationships', async () => {
    const { pageSetup } = await native.readRange(bytes, 'Acceptance', range)
    assert.equal(pageSetup.oddHeader, '&L&G')
    assert.equal(pageSetup.evenFooter, '&R&G')
    const [{ id, ...picture }] = pageSetup.headerFooterPictures
    assert.equal(pageSetup.headerFooterPictures.length, 1)
    assert.deepEqual(picture, { position: 'LH', widthPt: 72, heightPt: 36, mediaType: 'image/png' })
    assert.deepEqual(await native.readMedia(bytes, id), { mediaType: 'image/png', base64: png.toString('base64') })
  })

  await t.test('renders cached previews for VML and objectPr without a duplicate drawing fallback', async () => {
    const objects = metadata.visuals
    assert.deepEqual(objects.map(({ kind, progId }) => [kind, progId]), [['ole', 'Word.Document.12'], ['ole', 'Package']])
    const [modern, legacy] = objects
    assert.equal(modern.anchor.fromColumn, 1)
    assert.equal(legacy.anchor.fromRow, 4)
    assert.equal(legacy.anchor.toColumnOffset, 9525)
    assert.equal(legacy.lineColor, '#224466')
    assert.equal(legacy.fillColor, '#CCDDFF')
    assert.equal(legacy.drawingPath, undefined)
    assert.deepEqual(await native.readMedia(bytes, modern.id), {
      mediaType: 'image/x-emf', base64: Buffer.from('synthetic metafile bytes').toString('base64'),
    })
    assert.deepEqual(await native.readMedia(bytes, legacy.id), { mediaType: 'image/png', base64: png.toString('base64') })
  })

  await t.test('preserves the original VML, previews and embedding through ordinary saves', async () => {
    const request = sheetsSaveRequest('sheet-1', [{ row: 0, column: 0, value: 7, writeValue: true }])
    const result = await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))
    const saved = await JSZip.loadAsync(result.bytes)
    for (const path of [stylesPath, stringsPath, 'xl/styles.xml', 'xl/drawings/header.vml', 'xl/drawings/ole.vml',
      'xl/worksheets/_rels/sheet1.xml.rels', 'xl/media/fixture.png', 'xl/media/ole.emf', 'xl/embeddings/object.bin']) {
      assert.deepEqual(await saved.file(path).async('nodebuffer'), await zip.file(path).async('nodebuffer'), path)
    }
    const { pageSetup } = await native.readRange(result.bytes, 'Acceptance', range)
    assert.equal(pageSetup.headerFooterPictures[0].position, 'LH')
    assert.deepEqual((await native.inspect(result.bytes)).visuals, metadata.visuals)
  })
})
