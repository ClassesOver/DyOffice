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

const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const sheetPath = 'xl/worksheets/sheet1.xml'
const stylesPath = 'xl/styles.xml'
const workbookPath = 'xl/workbook.xml'
const sheetName = 'Acceptance'
const worksheet = (body) => `<worksheet xmlns="${spreadsheet}">${body}</worksheet>`

const styleSheet = `<s:styleSheet xmlns:s='${spreadsheet}' xmlns:x="${spreadsheet}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <s:numFmts count="1"><x:numFmt numFmtId="164" formatCode="0.00000"/></s:numFmts>
  <s:fonts count="1"><s:font><s:name val="Example Sans"/><s:sz val="17"/><s:b/></s:font></s:fonts>
  <s:fills count="1"><s:fill><s:patternFill patternType="solid"><s:fgColor rgb="FFFFFF00"/></s:patternFill></s:fill></s:fills>
  <s:borders count="1"><s:border/></s:borders>
  <s:cellStyleXfs count="1"><s:xf/></s:cellStyleXfs>
  <s:cellXfs count="2"><s:xf/><mc:AlternateContent><mc:Choice Requires="x"><x:xf numFmtId="0"/></mc:Choice><mc:Fallback><x:xf fontId="0" fillId="0" numFmtId="164"><x:alignment horizontal="center"/></x:xf></mc:Fallback></mc:AlternateContent></s:cellXfs>
  <s:dxfs count="1"><x:dxf><x:font><x:i/></x:font></x:dxf></s:dxfs>
</s:styleSheet>`

test('Web XLSX workbook inspection and reading', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-read-parity-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime(
    {
      DYOFFICE_AUTH_MODE: 'local',
      DYOFFICE_SANDBOX_MODE: 'subprocess',
      DYOFFICE_DEPLOYMENT_ID: randomUUID(),
      DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
      DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
    },
    { enabled: true },
  )
  t.after(() => runtime.close())
  const native = runtime.sheetsNative
  const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))

  const workbook = async (parts) => {
    const zip = await JSZip.loadAsync(original)
    for (const [path, contents] of Object.entries(parts)) {
      zip.file(
        path,
        typeof contents === 'function' ? contents(await zip.file(path).async('string')) : contents,
      )
    }
    return zip.generateAsync({ type: 'nodebuffer' })
  }
  const saveValue = async (bytes, column, value) => {
    const request = sheetsSaveRequest('sheet-1', [{ row: 0, column, value, writeValue: true }])
    return (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
  }

  await t.test('decodes inline and rich text whitespace like GenOffice after save and reopen', async () => {
    const bytes = await workbook({
      [sheetPath]: worksheet(`<sheetData><row r="1">
        <c r="A1" t="inlineStr"><is><t> &#9;Label&#10; </t></is></c>
        <c r="B1" t="inlineStr"><is><t xml:space='preserve'>  Padded  </t></is></c>
        <c r="C1" t="inlineStr"><is><r><rPr><b/></rPr><t> First </t></r>
          <r><t xml:space="preserve"> Second </t></r></is></c>
        <c r="D1" t="inlineStr"><is><t> _x0020_fixed_x0020_ </t></is></c>
      </row></sheetData>`),
    })
    const check = async (input) => {
      const { cells } = await native.readRange(input, sheetName, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 3 })
      assert.deepEqual(cells.map(({ value }) => value), ['Label', '  Padded  ', 'First Second ', ' fixed '])
      assert.deepEqual(cells[2].rich.map(({ text, bold }) => [text, bold]), [['First', true], [' Second ', false]])
    }
    await check(bytes)
    await check(await saveValue(bytes, 4, 42))
  })

  await t.test(
    'empty numeric and invalid string index cells retain blank values and styles',
    async () => {
      const bytes = await workbook({
        [sheetPath]: worksheet(
          '<sheetData><row r="1">' +
            '<c r="A1" s="1"><v></v></c><c r="B1" s="1" t="s"><v> </v></c>' +
            '<c r="C1" s="1" t="s"><v>99</v></c><c r="D1" t="s"><v>0</v></c>' +
            '<c r="E1" t="str"><f>IF(TRUE,"",1)</f><v></v></c><c r="F1"><v>12</v></c>' +
            '</row></sheetData>',
        ),
        'xl/sharedStrings.xml': `<sst xmlns="${spreadsheet}" count="1" uniqueCount="1"><si><t>First label</t></si></sst>`,
        '[Content_Types].xml': (xml) =>
          xml.replace(
            '</Types>',
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
          ),
        'xl/_rels/workbook.xml.rels': (xml) =>
          xml.replace(
            '</Relationships>',
            '<Relationship Id="rIdStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
          ),
      })
      const range = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 5 }
      const values = async (input) =>
        (await native.readRange(input, sheetName, range)).cells.map(
          ({ column, value, styleIndex }) => [column, value, styleIndex],
        )
      const expected = [
        [0, null, 1],
        [1, null, 1],
        [2, null, 1],
        [3, 'First label', 0],
        [4, '', 0],
      ]
      assert.deepEqual(await values(bytes), [...expected, [5, 12, 0]])
      assert.deepEqual(await values(await saveValue(bytes, 5, 27)), [
        ...expected,
        [5, 27, 0],
      ])
    },
  )

  await t.test(
    'reads mixed stylesheet aliases and the markup compatibility fallback in index order',
    async () => {
      const bytes = await workbook({ [stylesPath]: styleSheet })
      const { styles, dxfStyles } = await native.inspect(bytes)
      assert.equal(styles.length, 2)
      const { fontFamily, fontSize, bold, fillColor, numberFormat, horizontalAlignment } = styles[1]
      assert.deepEqual(
        [fontFamily, fontSize, bold, fillColor, numberFormat, horizontalAlignment],
        ['Example Sans', 17, true, '#FFFF00', '0.00000', 'center'],
      )
      assert.equal(dxfStyles[0].italic, true)
    },
  )

  await t.test('resolves scheme faces while retaining the literal Normal font', async () => {
    const bytes = await workbook({
      'xl/theme/theme1.xml': `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Audit">
        <a:themeElements><a:fontScheme name="Audit">
          <a:majorFont><a:latin typeface="Georgia"/></a:majorFont>
          <a:minorFont><a:latin typeface="Arial"/><a:ea typeface="MS PGothic"/></a:minorFont>
        </a:fontScheme></a:themeElements>
      </a:theme>`,
      [stylesPath]: `<styleSheet xmlns="${spreadsheet}">
        <fonts count="3">
          <font><name val="MS PGothic"/><sz val="11"/><scheme val="minor"/></font>
          <font><name val="Cambria"/><sz val="12"/><scheme val="major"/></font>
          <font><name val="Courier New"/></font>
        </fonts>
        <cellXfs count="3"><xf fontId="0"/><xf fontId="1"/><xf fontId="2"/></cellXfs>
      </styleSheet>`,
    })
    const { styles, themeFonts, normalFontName } = await native.inspect(bytes)
    assert.deepEqual(
      styles.map(({ fontFamily }) => fontFamily),
      ['Arial', 'Georgia', 'Courier New'],
    )
    assert.deepEqual(themeFonts, { major: 'Georgia', minor: 'Arial', minorEa: 'MS PGothic' })
    assert.equal(normalFontName, 'MS PGothic')
  })

  await t.test('uses the outermost valid stops for cell and differential gradients', async () => {
    const gradient = `<gradientFill>
      <stop position="1"><color rgb="FF0000FF"/></stop>
      <stop position="0"><color rgb="FFFF0000"/></stop>
      <stop position="0.4"><color rgb="FFFFFFFF"/></stop>
      <stop position="bad"><color rgb="FF00FF00"/></stop>
      <stop position="2"><color rgb="bad"/></stop>
    </gradientFill>`
    const bytes = await workbook({
      [stylesPath]: `<styleSheet xmlns="${spreadsheet}">
        <fills count="1"><fill>${gradient}</fill></fills>
        <cellXfs count="1"><xf fillId="0"/></cellXfs>
        <dxfs count="1"><dxf><fill>${gradient}</fill></dxf></dxfs>
      </styleSheet>`,
    })
    const { styles, dxfStyles } = await native.inspect(bytes)
    assert.deepEqual([styles[0].fillColor, dxfStyles[0].fillColor], ['#7F007F', '#7F007F'])
  })

  await t.test('blends patterned cell fills and preserves solid and none fills', async () => {
    const colors = '<fgColor rgb="FF000000"/><bgColor rgb="FFFFFFFF"/>'
    const bytes = await workbook({
      [stylesPath]: `<styleSheet xmlns="${spreadsheet}">
        <fills count="3">
          <fill><patternFill patternType="darkHorizontal">${colors}</patternFill></fill>
          <fill><patternFill patternType="solid">${colors}</patternFill></fill>
          <fill><patternFill patternType="none">${colors}</patternFill></fill>
        </fills>
        <cellXfs count="3"><xf fillId="0"/><xf fillId="1"/><xf fillId="2"/></cellXfs>
        <dxfs count="1"><dxf><fill><patternFill>${colors}</patternFill></fill></dxf></dxfs>
      </styleSheet>`,
    })
    const { styles, dxfStyles } = await native.inspect(bytes)
    assert.deepEqual(
      styles.map(({ fillColor }) => fillColor),
      ['#7F7F7F', '#000000', undefined],
    )
    assert.equal(dxfStyles[0].fillColor, '#FFFFFF')
  })

  await t.test('reports the 1904 date system on open and after saving', async () => {
    const bytes = await workbook({
      [workbookPath]: (xml) =>
        xml.replace('<bookViews>', '<workbookPr date1904="true"/><bookViews>'),
    })
    assert.equal((await native.inspect(bytes)).date1904, true)
    assert.equal((await native.inspect(await saveValue(bytes, 0, 27))).date1904, true)
    assert.notEqual((await native.inspect(original)).date1904, true)
  })

  await t.test(
    'keeps finite declared extents and ignores each full-sheet axis independently',
    async () => {
      const cells = '<sheetData><row r="2"><c r="B2"><v>2</v></c></row></sheetData>'
      const extent = async (ref) => {
        const bytes = await workbook({
          [sheetPath]: worksheet(`<dimension ref="${ref}"/>${cells}`),
        })
        const { rowCount, columnCount, valueRowCount, valueColumnCount } = (
          await native.inspect(bytes)
        ).sheets[0]
        return [rowCount, columnCount, valueRowCount, valueColumnCount]
      }
      assert.deepEqual(await extent('A1:AZ400'), [400, 52, 2, 2])
      assert.deepEqual(await extent('A1:C1048576'), [2, 3, 2, 2])
      assert.deepEqual(await extent('A1:XFD5'), [5, 2, 2, 2])
      assert.deepEqual(await extent('A1'), [2, 2, 2, 2])
    },
  )

  await t.test('uses the default fallback for a zero base column width', async () => {
    const bytes = await workbook({
      [sheetPath]: worksheet(
        '<sheetFormatPr baseColWidth="0" defaultColWidth="0" defaultRowHeight="15"/><sheetData/>',
      ),
    })
    const { baseColumnWidth, defaultColumnWidth, defaultRowHeight } = (await native.inspect(bytes))
      .sheets[0]
    assert.deepEqual([baseColumnWidth, defaultColumnWidth, defaultRowHeight], [null, null, 15])
  })

  await t.test('keeps grid sizing and formatting separate from populated row and column metadata', async () => {
    const bytes = await workbook({
      [sheetPath]: worksheet(
        `<cols><col min="1" max="2" width="12"/><col min="3" max="3" customWidth="1"/>
          <col min="4" max="16384" width="17" style="1"/></cols>
        <sheetData><row r="2"><c r="B2"><v>2</v></c></row>
          <row ht="21" customHeight="1"/><row r="4" hidden="1" customHeight="1"/>
          <row r="5" ht="19"/><row r="30"/></sheetData>`,
      ),
    })
    const [{ rowCount, columnCount, columnWidths }] = (await native.inspect(bytes)).sheets
    assert.deepEqual([rowCount, columnCount], [30, 2])
    assert.deepEqual(columnWidths, [
      { startColumn: 0, endColumn: 1, width: 12, hidden: false },
      { startColumn: 3, endColumn: 16_383, width: 17, hidden: false, styleIndex: 1 },
    ])
    const { rows } = await native.readRange(bytes, sheetName, { startRow: 0, endRow: 29, startColumn: 0, endColumn: 1 })
    assert.deepEqual(rows, [
      { row: 2, height: 21, customHeight: true, hidden: false },
      { row: 3, hidden: true },
      { row: 4, height: 19, hidden: false },
    ])
  })

  await t.test('does not spend the stored cell budget on bare empty cells', async () => {
    const blankRows = Array.from({ length: 50_000 }, (_, i) => {
      const row = i + 2
      return `<row r="${row}"><c r="A${row}"/></row>`
    }).join('')
    const bytes = await workbook({
      [sheetPath]: worksheet(`<sheetData><row r="1"><c r="A1"><v>42</v></c><c r="B1" s="1"/><c r="C1"/></row>${blankRows}</sheetData>`),
    })
    const [{ storedCellCount, valueCellCount, rowCount }] = (await native.inspect(bytes)).sheets
    assert.deepEqual([storedCellCount, valueCellCount, rowCount], [2, 1, 50_001])
  })

  await t.test('applies the Normal cell style with or without an explicit zero style index', async () => {
    const bytes = await workbook({
      [stylesPath]: `<styleSheet xmlns="${spreadsheet}">
        <fonts count="1"><font><name val="Example Sans"/><b/></font></fonts>
        <cellXfs count="1"><xf fontId="0" numFmtId="2"/></cellXfs>
      </styleSheet>`,
      [sheetPath]: worksheet('<sheetData><row r="1"><c r="A1"><v>1.25</v></c><c r="B1" s="0"><v>1.25</v></c></row></sheetData>'),
    })
    const range = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }
    const cells = (await native.readRange(bytes, sheetName, range)).cells
    assert.deepEqual(cells.map(({ styleIndex }) => styleIndex), [0, 0])
  })

  await t.test('reads and finds future functions by their unprefixed formula text', async () => {
    const formula = '=XLOOKUP(B1,C1,C1,"_xlfn.literal")'
    const bytes = await workbook({
      [sheetPath]: worksheet('<sheetData><row r="1"><c r="A1"><f>_xlfn.XLOOKUP(B1,C1,C1,"_xlfn.literal")</f><v>2</v></c></row></sheetData>'),
    })
    const found = await native.findCells(bytes, sheetName, {
      query: formula, matchEntireCell: true, lookIn: 'formulas_only', limit: 10,
    })
    assert.deepEqual(found.matches.map(({ formulaText }) => formulaText), [formula])
    assert.equal((await native.readSheet(bytes, sheetName, 'formulas')).cells[0].formula, formula)
  })

  await t.test('compacts a large shared formula range without truncating the index', async () => {
    const count = 100_001
    const rows = Array.from({ length: count }, (_, index) => {
      const row = index + 1
      const formula = index === 0
        ? `<f t="shared" si="0" ref="A1:A${count}">B1+1</f>`
        : '<f t="shared" si="0"/>'
      return `<row r="${row}"><c r="A${row}">${formula}<v>${row}</v></c></row>`
    }).join('')
    const bytes = await workbook({ [sheetPath]: worksheet(`<sheetData>${rows}</sheetData>`) })
    const { cells, sharedGroups, truncated } = await native.readSheet(bytes, sheetName, 'formulas')
    assert.equal(truncated, false)
    assert.deepEqual(cells.map(({ formula }) => formula), ['=B1+1'])
    assert.deepEqual(sharedGroups, [{
      si: 0, row: 0, column: 0, formula: '=B1+1',
      range: { startRow: 0, endRow: count - 1, startColumn: 0, endColumn: 0 },
    }])
  })

  await t.test('lists sparse shared formula followers and keeps the expanded index available', async () => {
    const bytes = await workbook({
      [sheetPath]: worksheet('<sheetData>' +
        '<row r="1"><c r="A1"><f t="shared" si="1" ref="A1:A3">B1+1</f><v>4</v></c></row>' +
        '<row r="3"><c r="A3"><f t="shared" si="1"/><v>6</v></c></row>' +
        '</sheetData>'),
    })
    const compact = await native.readSheet(bytes, sheetName, 'formulas')
    assert.deepEqual(compact.cells.map(({ formula }) => formula), ['=B1+1'])
    assert.deepEqual(compact.sharedGroups, [{ si: 1, row: 0, column: 0, formula: '=B1+1', cells: [[2, 0]] }])
    const [expanded] = await native.readFormulaIndex(bytes)
    assert.deepEqual(expanded.cells.map(({ formula }) => formula), ['=B1+1', '=B3+1'])
  })
})
