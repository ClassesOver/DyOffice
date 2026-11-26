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

  await t.test('opens and saves prefixed workbook and worksheet parts containing comments and CDATA', async () => {
    const comment = '<!-- <x:c xmlns:x="urn:comment"/> -->'
    const literal = '<x:row r="97"> sample </x:row>'
    const bytes = await workbook({
      [workbookPath]: `<!-- workbook metadata --><x:workbook xmlns:x='${spreadsheet}'
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <x:sheets><x:sheet name="Acceptance" sheetId="1" r:id="rId1"/></x:sheets>
        <x:definedNames><x:definedName name="Example"><![CDATA[Acceptance!A1]]></x:definedName></x:definedNames>
      </x:workbook>`,
      [sheetPath]: `<x:worksheet xmlns:x='${spreadsheet}'><x:sheetData><x:row r="1">
        <x:c r="A1" t="inlineStr"><x:is>${comment}<x:t><![CDATA[${literal}]]></x:t></x:is></x:c>
        <x:c r="B1"><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    })
    const values = async (input) => (await native.readRange(input, sheetName, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }))
      .cells.map(({ value }) => value)
    assert.deepEqual(await values(bytes), [literal, 7])
    const saved = await saveValue(bytes, 1, 42)
    assert.deepEqual(await values(saved), [literal, 42])
    assert.deepEqual((await native.inspect(saved)).definedNames, [{ name: 'Example', formula: 'Acceptance!A1' }])
    const xml = await (await JSZip.loadAsync(saved)).file(sheetPath).async('string')
    assert.ok(xml.includes(comment))
  })

  await t.test('saves workbooks with default and prefixed elements in the same namespace', async () => {
    const bytes = await workbook({
      [workbookPath]: `<x:workbook xmlns="${spreadsheet}" xmlns:x="${spreadsheet}"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><x:sheet name="Acceptance" sheetId="1" r:id="rId1"/></sheets>
      </x:workbook>`,
      [sheetPath]: `<worksheet xmlns="${spreadsheet}" xmlns:x="${spreadsheet}">
        <x:sheetData><row r="1"><x:c r="A1"><v>7</v></x:c></row></x:sheetData>
      </worksheet>`,
    })
    const values = async (input) => (await native.readRange(input, sheetName, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }))
      .cells.map(({ value }) => value)
    assert.deepEqual(await values(bytes), [7])
    assert.deepEqual(await values(await saveValue(bytes, 0, 42)), [42])
  })

  await t.test('opens and saves both empty-tag and expanded worksheet declarations with single quotes', async () => {
    const declarations = [
      "<sheet name='Acceptance' sheetId=\"1\" r:id='rId1'/>",
      "<sheet name = 'Accept\"ance' sheetId = '1' r:id = 'rId1'> \n </sheet>",
    ]
    for (const [index, declaration] of declarations.entries()) {
      const name = index ? 'Accept"ance' : 'Acceptance'
      const bytes = await workbook({ [workbookPath]: (xml) => xml.replace(/<sheet\b[^>]*\/>/, declaration) })
      const identity = [{ id: 'sheet-1', name }]
      const sheets = async (input) => (await native.inspect(input)).sheets.map(({ id, name }) => ({ id, name }))
      assert.deepEqual(await sheets(bytes), identity)
      const saved = await saveValue(bytes, 0, 'edited')
      assert.deepEqual(await sheets(saved), identity)
      const { cells } = await native.readRange(saved, name, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })
      assert.equal(cells[0].value, 'edited')
    }
    const duplicate = await workbook({
      [workbookPath]: (xml) => xml.replace(/<sheet\b[^>]*\/>/, "<sheet name='Acceptance' sheetId='1' sheetId='2' r:id='rId1'/>"),
    })
    await assert.rejects(() => saveValue(duplicate, 0, 'edited'), /Invalid workbook input/)
  })

  await t.test('keeps literal worksheet text through bulk fills and row inserts', async t => {
    const literal = 'Example </row><row r="97"><c r="A97"> text'
    const comment = '<!-- <row r="99"/> -->'
    const bytes = await workbook({
      [sheetPath]: worksheet(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is>${comment}<t><![CDATA[${literal}]]></t></is></c>
        <c r="B1"><v>7</v></c></row><row r="2"><c r="B2"><v>8</v></c></row></sheetData>`),
    })
    const save = async (fields) => {
      const request = { ...sheetsSaveRequest('sheet-1', []), ...fields }
      const result = (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
      const xml = await (await JSZip.loadAsync(result)).file(sheetPath).async('string')
      assert.ok(xml.includes(comment))
      const { cells } = await native.readRange(result, sheetName, { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 })
      return cells.map(({ row, column, value }) => [row, column, value])
    }
    await t.test('bulk fill', async () => {
      assert.deepEqual(await save({ bulkConstantFills: [{
        sheetId: 'sheet-1', startRow: 0, endRow: 1, startColumn: 1, endColumn: 1, value: 42,
      }] }), [[0, 0, literal], [0, 1, 42], [1, 1, 42]])
    })
    await t.test('row insert', async () => {
      assert.deepEqual(await save({ structuralOps: [{ sheetId: 'sheet-1', kind: 'insert-rows', index: 0, count: 1 }] }),
        [[1, 0, literal], [1, 1, 7], [2, 1, 8]])
    })
  })

  await t.test('saves defined names with CDATA and ignores declaration lookalikes in package comments', async () => {
    const workbookComment = '<!-- <sheet name="Ghost" sheetId="999" r:id="rId1"/> -->'
    const relationships = 'xl/_rels/workbook.xml.rels'
    const relationshipComment = '<!-- <Relationship Id="rId1" Target="worksheets/missing.xml" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/> -->'
    const formula = 'IF(Acceptance!A1<2,"A&B","<sheet/>")'
    const bytes = await workbook({
      [workbookPath]: (xml) => xml.replace('<sheets>', '<sheets>' + workbookComment).replace('</definedNames>',
        `<definedName name="Literal"><![CDATA[${formula}]]></definedName></definedNames>`),
      [relationships]: (xml) => xml.replace('<Relationship Id=', relationshipComment + '<Relationship Id='),
    })
    const saved = await saveValue(bytes, 0, 'edited')
    for (const input of [bytes, saved]) {
      const inspected = await native.inspect(input)
      assert.deepEqual(inspected.sheets.map(({ name }) => name), ['Acceptance'])
      assert.deepEqual(inspected.definedNames.find(({ name }) => name === 'Literal'), { name: 'Literal', formula })
    }
    assert.equal((await native.readRange(saved, sheetName, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 })).cells[0].value, 'edited')
    const zip = await JSZip.loadAsync(saved)
    assert.ok((await zip.file(workbookPath).async('string')).includes(workbookComment))
    assert.ok((await zip.file(relationships).async('string')).includes(relationshipComment))
  })

  await t.test('reads literal CDATA in cell text and preserves it through an adjacent edit', async () => {
    const bytes = await workbook({
      [sheetPath]: worksheet(`<sheetData><row r="1">
        <c r="A1" t="inlineStr"><is><t> Start &amp; <!-- ignored <row r="999"/> -->
          <![CDATA[&amp; </t> </is> </c>]]> End </t></is></c>
        <c r="C1" t="inlineStr"><is><r><rPr><b/></rPr><t><![CDATA[</r>]]></t></r>
          <r><t xml:space="preserve"> Text </t></r></is></c>
        <c r="D1"><v><![CDATA[12.5]]></v></c>
        <c r="E1" t="str"><v><![CDATA[&amp; </v>]]></v></c>
      </row></sheetData>`),
    })
    const check = async (input) => {
      const { cells } = await native.readRange(input, sheetName, { startRow: 0, endRow: 0, startColumn: 0, endColumn: 4 })
      assert.equal(cells.find(({ column }) => column === 0).value, 'Start & \n          &amp; </t> </is> </c> End')
      const rich = cells.find(({ column }) => column === 2)
      assert.equal(rich.value, '</r> Text ')
      assert.deepEqual(rich.rich.map(({ text, bold }) => [text, bold]), [['</r>', true], [' Text ', false]])
      assert.equal(cells.find(({ column }) => column === 3).value, 12.5)
      assert.equal(cells.find(({ column }) => column === 4).value, '&amp; </v>')
    }
    await check(bytes)
    const saved = await saveValue(bytes, 1, 42)
    await check(saved)
    const savedXml = await (await JSZip.loadAsync(saved)).file(sheetPath).async('string')
    assert.match(savedXml, /<!-- ignored <row r="999"\/> -->/)
    const declared = await workbook({ [sheetPath]: `<!DOCTYPE worksheet>${savedXml}` })
    await assert.rejects(() => saveValue(declared, 1, 43), /Invalid workbook input/)
  })

  await t.test('opens a workbook with a broken pivot output reference alongside a usable pivot', async () => {
    const broken = 'xl/pivotTables/pivotTable1.xml'
    const usable = 'xl/pivotTables/pivotTable2.xml'
    const pivot = (name, location) => `<pivotTableDefinition xmlns="${spreadsheet}" name="${name}" cacheId="1">
      ${location}<pivotTableStyleInfo name="PivotStyleLight1"/></pivotTableDefinition>`
    const bytes = await workbook({
      [broken]: pivot('Broken', '<location ref="#REF!" firstDataRow="-1" firstDataCol="invalid"/>'),
      [usable]: pivot('Usable', "<location ref='$d$4:$c$2' firstDataRow='1' firstDataCol='0'/>"),
      'xl/worksheets/_rels/sheet1.xml.rels': (xml) => xml.replace('</Relationships>', [broken, usable].map((path, index) =>
        `<Relationship Id="auditPivot${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../${path.slice(3)}"/>`,
      ).join('') + '</Relationships>'),
      '[Content_Types].xml': (xml) => xml.replace('</Types>', [broken, usable].map((path) =>
        `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>`,
      ).join('') + '</Types>'),
    })
    const [{ pivotTables, pivotRanges }] = (await native.inspect(bytes)).sheets
    assert.deepEqual(pivotTables.map(({ outputRef, firstDataRow, firstDataCol }) => [outputRef, firstDataRow, firstDataCol]), [
      ['#REF!', 1, 1], ['$d$4:$c$2', 1, 0],
    ])
    assert.ok(pivotTables.every(pivot => !Object.hasOwn(pivot, 'rowKinds')))
    assert.deepEqual(pivotRanges, [{ startRow: 1, startColumn: 2, endRow: 3, endColumn: 3 }])
    const { cells } = await native.readRange(bytes, sheetName, { startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 })
    assert.equal(cells[0].value, 12.5)
  })

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
