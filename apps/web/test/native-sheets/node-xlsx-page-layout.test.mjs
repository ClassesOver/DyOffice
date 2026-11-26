import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { XMLValidator } from 'fast-xml-parser'
import JSZip from 'jszip'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

const sheetPart = 'xl/worksheets/sheet1.xml'
const workbookPart = 'xl/workbook.xml'
const range = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 5 }

test('Web XLSX saves view and print settings without changing other worksheet state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-page-layout-'))
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
  const workbook = async (editSheet, editWorkbook) => {
    const zip = await JSZip.loadAsync(original)
    zip.file(sheetPart, editSheet(await zip.file(sheetPart).async('string')))
    if (editWorkbook)
      zip.file(workbookPart, editWorkbook(await zip.file(workbookPart).async('string')))
    return zip.generateAsync({ type: 'nodebuffer' })
  }
  const save = async (bytes, state) => {
    const request = sheetsSaveRequest('sheet-1', [])
    request.pageSetupStates = [{ sheetId: 'sheet-1', ...state }]
    return (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes
  }
  const sheetXml = async (bytes) => (await JSZip.loadAsync(bytes)).file(sheetPart).async('string')
  const pageSetup = async (bytes) => (await native.readRange(bytes, 'Acceptance', range)).pageSetup

  await t.test(
    'updates single-quoted attributes and clears settings restored to their default',
    async () => {
      const bytes = await workbook((xml) =>
        xml
          .replace(
            '<sheetView workbookViewId="0"/>',
            "<sheetView workbookViewId='0' showGridLines = '0' zoomScale='75'/>",
          )
          .replace(
            '<drawing ',
            "<pageSetup orientation = 'portrait' scale='75' paperSize='9' xmlns:audit='urn:test' audit:note=\"orientation='portrait' >\"/><drawing ",
          ),
      )
      assert.equal((await native.inspect(bytes)).sheets[0].showGridLines, false)
      const saved = await save(bytes, {
        showGridlines: true,
        zoomScale: 100,
        orientation: 'landscape',
        scale: 100,
      })
      const xml = await sheetXml(saved)
      assert.equal(XMLValidator.validate(xml), true)
      assert.ok(xml.includes(`audit:note="orientation='portrait' >"`))
      const layout = await pageSetup(saved)
      assert.deepEqual(
        [layout.orientation, layout.paperSize, layout.scale],
        ['landscape', 9, undefined],
      )
      const view = (await native.inspect(saved)).sheets[0]
      assert.equal(view.showGridLines, true)
      assert.equal(view.zoomScale, undefined)
    },
  )

  await t.test(
    'keeps fit-to-page inside sheet properties and clears a quoted setting',
    async () => {
      const bytes = await workbook((xml) =>
        xml.replace('<dimension ', '<sheetPr codeName="LayoutSheet"/><dimension '),
      )
      const fitted = await save(bytes, { fitToPage: true, fitToWidth: 2 })
      const fittedXml = await sheetXml(fitted)
      assert.match(
        fittedXml,
        /<sheetPr codeName="LayoutSheet"><pageSetUpPr fitToPage="1"\/><\/sheetPr>/,
      )
      assert.equal((await pageSetup(fitted)).fitToPage, true)
      assert.equal((await pageSetup(fitted)).fitToWidth, 2)

      const quoted = await workbook((xml) =>
        xml.replace(
          '<dimension ',
          "<sheetPr><tabColor rgb='FF123456'/><pageSetUpPr autoPageBreaks='0' fitToPage='1'/></sheetPr><dimension ",
        ),
      )
      const scaled = await save(quoted, { fitToPage: false, scale: 80 })
      assert.match(
        await sheetXml(scaled),
        /<tabColor rgb='FF123456'\/><pageSetUpPr autoPageBreaks='0'\/>/,
      )
      assert.equal((await pageSetup(scaled)).fitToPage, undefined)
      assert.equal((await pageSetup(scaled)).scale, 80)
    },
  )

  await t.test(
    'reads, saves and clears the last workbook view without changing the earlier view',
    async () => {
      const first =
        '<sheetView workbookViewId="0" zoomScale="75"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        "<selection pane='bottomLeft' activeCell='A2' sqref='A2'/></sheetView>"
      const second =
        '<sheetView workbookViewId="1" zoomScale="130" showGridLines="0"><pane xSplit="2" topLeftCell="C1" activePane="topRight" state="frozen"/>' +
        '<selection pane="topRight" activeCell="D1" sqref="D1"/></sheetView>'
      const bytes = await workbook(
        (xml) => xml.replace('<sheetView workbookViewId="0"/>', first + second),
        (xml) => xml.replace('<workbookView/>', '<workbookView/><workbookView/>'),
      )
      const initial = (await native.inspect(bytes)).sheets[0]
      assert.equal(initial.zoomScale, 130)
      assert.equal(initial.showGridLines, false)
      assert.deepEqual(initial.freeze, { frozenRows: 0, frozenColumns: 2 })
      const frozen = await save(bytes, { frozenRows: 2, frozenColumns: 0, zoomScale: 90 })
      const xml = await sheetXml(frozen)
      assert.ok(xml.includes(first))
      assert.doesNotMatch(xml, /<selection pane="topRight"/)
      assert.equal((await native.inspect(frozen)).sheets[0].zoomScale, 90)
      assert.deepEqual((await native.inspect(frozen)).sheets[0].freeze, {
        frozenRows: 2,
        frozenColumns: 0,
      })
      const cleared = await save(frozen, { frozenRows: 0, frozenColumns: 0 })
      assert.ok((await sheetXml(cleared)).includes(first))
      assert.equal((await native.inspect(cleared)).sheets[0].freeze, null)
    },
  )

  const customView = (contents) =>
    `<customSheetViews><customSheetView guid="{11111111-1111-1111-1111-111111111111}">${contents}</customSheetView></customSheetViews>`
  const beforeDrawing = (xml, contents) => xml.replace('<drawing ', contents + '<drawing ')
  const header = (text) => `<headerFooter><oddHeader>&amp;C${text}</oddHeader></headerFooter>`
  const rowBreak = (row) =>
    `<rowBreaks count="1" manualBreakCount="1"><brk id="${row}" min="0" max="16383" man="1"/></rowBreaks>`

  await t.test(
    'creates active print options, margins and orientation without changing the custom view',
    async () => {
      const view = customView(
        '<printOptions headings="0"/><pageMargins left="1" right="1" top="1" bottom="1" header="0.5" footer="0.5"/><pageSetup orientation="portrait"/>',
      )
      const bytes = await workbook((xml) => beforeDrawing(xml, view))
      assert.equal(await pageSetup(bytes), null)
      const saved = await save(bytes, {
        orientation: 'landscape',
        printHeadings: true,
        margins: 'narrow',
      })
      const xml = await sheetXml(saved)
      assert.ok(xml.includes(view))
      assert.match(
        xml,
        /<\/customSheetViews><printOptions[^>]*\/><pageMargins[^>]*\/><pageSetup[^>]*\/><drawing /,
      )
      const setup = await pageSetup(saved)
      assert.equal(setup.orientation, 'landscape')
      assert.equal(setup.printHeadings, true)
      assert.equal(setup.margins.left, 0.25)
    },
  )

  await t.test('updates and clears the active header independently of the saved view', async () => {
    const view = customView(header('Saved view'))
    const bytes = await workbook((xml) => beforeDrawing(xml, view + header('Active sheet')))
    const saved = await save(bytes, { header: { center: 'New active header' } })
    assert.equal((await pageSetup(saved)).oddHeader, '&CNew active header')
    assert.ok((await sheetXml(saved)).includes(view))
    const cleared = await save(saved, { header: null })
    assert.equal(await pageSetup(cleared), null)
    assert.ok((await sheetXml(cleared)).includes(view))
  })

  await t.test(
    'replaces and clears active row breaks while retaining custom view breaks',
    async () => {
      const view = customView(rowBreak(3))
      const bytes = await workbook((xml) => beforeDrawing(xml, view + rowBreak(2)))
      const rowBreaks = async (input) =>
        (await native.readRange(input, 'Acceptance', range)).rowBreaks
      const saved = await save(bytes, { rowBreaks: [1] })
      assert.deepEqual(await rowBreaks(saved), [1])
      const xml = await sheetXml(saved)
      assert.ok(xml.includes(view))
      assert.ok(!xml.includes(rowBreak(2)))
      const cleared = await save(saved, { rowBreaks: [] })
      assert.deepEqual(await rowBreaks(cleared), [])
      assert.ok((await sheetXml(cleared)).includes(view))
    },
  )

  await t.test(
    'replaces and clears quoted print names and preserves the existing title columns',
    async () => {
      const oldArea =
        "<definedName name='_xlnm.Print_Area' localSheetId='0'>'Acceptance'!$A$1:$B$2</definedName>"
      const oldTitles =
        "<definedName localSheetId = '0' name='_xlnm.Print_Titles'>'Acceptance'!$A:$B,'Acceptance'!$1:$2</definedName>"
      const bytes = await workbook(
        (xml) => xml,
        (xml) => xml.replace('</definedNames>', oldArea + oldTitles + '</definedNames>'),
      )
      const saved = await save(bytes, { printArea: 'C1:D3', printTitles: '3:4' })
      const info = async (input) => (await native.inspect(input)).sheets[0]
      const savedSheet = await info(saved)
      assert.equal(savedSheet.printArea, "'Acceptance'!$C$1:$D$3")
      assert.equal(savedSheet.printTitles, "'Acceptance'!$A:$B,'Acceptance'!$3:$4")
      const workbookXml = async (input) =>
        (await JSZip.loadAsync(input)).file(workbookPart).async('string')
      const savedXml = await workbookXml(saved)
      assert.equal((savedXml.match(/_xlnm\.Print_Area/g) ?? []).length, 1)
      assert.equal((savedXml.match(/_xlnm\.Print_Titles/g) ?? []).length, 1)
      const cleared = await save(saved, { printArea: null, printTitles: null })
      const clearedSheet = await info(cleared)
      assert.equal(clearedSheet.printArea, undefined)
      assert.equal(clearedSheet.printTitles, undefined)
      assert.match(await workbookXml(cleared), /<definedName name="Revenue">/)
    },
  )

  await t.test('inserts page setup after sheet data with a nested cell extension', async () => {
    const plain = '<c r="A2"><v>12.5</v></c>'
    const cell = '<c r="A2"><v>12.5</v><extLst><ext uri="audit"/></extLst></c>'
    const bytes = await workbook((xml) => xml.replace(plain, cell))
    const saved = await save(bytes, { orientation: 'landscape' })
    const xml = await sheetXml(saved)
    assert.ok(xml.includes(cell))
    assert.match(xml, /<\/sheetData><pageSetup orientation="landscape"\/><drawing /)
    assert.equal((await pageSetup(saved)).orientation, 'landscape')
  })
})
