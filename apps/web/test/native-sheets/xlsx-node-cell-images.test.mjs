import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

const fixture = new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)
const sheetPath = 'xl/worksheets/sheet1.xml'
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNgqP//HwAEfwJ+bbED2gAAAABJRU5ErkJggg=='
const officeRels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const sheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const range = { startRow: 0, endRow: 5, startColumn: 0, endColumn: 8 }

test(
  'Web Node reads Excel and WPS in-cell images through their workbook IDs',
  { timeout: 120_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-node-cell-images-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await buildSheetsGateway(join(dir, 'gateway.mjs'))
    const runtime = await configuredSheetsRuntime(
      {
        DYOFFICE_AUTH_MODE: 'local',
        DYOFFICE_SANDBOX_MODE: 'subprocess',
        DYOFFICE_DEPLOYMENT_ID: randomUUID(),
        DYOFFICE_XLSX_NODE_ENGINE: join(dir, 'xlsx-node-engine.mjs'),
        DYOFFICE_XLSX_GATEWAY_RUNNER: join(dir, 'gateway-process.mjs'),
      },
      { enabled: true },
    )
    t.after(() => runtime.close())
    const native = runtime.sheetsNative
    const save = async (bytes, request) =>
      (await native.savePlan(bytes, await runtime.sheetsWorkbookPlanner(bytes, request))).bytes

    await t.test(
      'opens the PNG inserted by the workbook save planner and suppresses the cached error',
      async () => {
        const request = sheetsSaveRequest('sheet-1', [])
        request.cellImageAdditions = [
          { sheetId: 'sheet-1', row: 2, column: 6, mediaType: 'image/png', base64: pixel },
        ]
        const bytes = await save(await readFile(fixture), request)
        const zip = await JSZip.loadAsync(bytes)
        assert.match(await zip.file(sheetPath).async('string'), /<c r="G3"[^>]*vm="1"/)
        assert.ok(zip.file('xl/media/image1.png'))
        const opened = await native.inspect(bytes, undefined, true)
        assert.deepEqual(opened.sheets[0].cellImages, [{ id: 'cell-image-0', row: 2, column: 6 }])
        const { cells } = await native.readRange(bytes, 'Acceptance', range)
        assert.deepEqual(
          cells
            .filter((cell) => cell.row === 2 && cell.column === 6)
            .map(({ value, formula }) => ({ value, formula })),
          [{ value: null, formula: undefined }],
        )
        assert.deepEqual(await native.readMedia(bytes, 'cell-image-0'), {
          mediaType: 'image/png',
          base64: pixel,
        })
        await assert.rejects(() => native.readMedia(bytes, 'image1.png'))
        await assert.rejects(() => native.readMedia(bytes, 'cell-image-1'))

        zip.remove('xl/media/image1.png')
        const missing = await zip.generateAsync({ type: 'nodebuffer' })
        assert.deepEqual((await native.inspect(missing)).sheets[0].cellImages, [])
        assert.equal(
          (await native.readRange(missing, 'Acceptance', range)).cells.find(
            (cell) => cell.row === 2 && cell.column === 6,
          ).value,
          '#VALUE!',
        )
      },
    )

    await t.test(
      'only replaces resolved DISPIMG formula cells and keeps cells after the overlay limit',
      async () => {
        const zip = await JSZip.loadAsync(await readFile(fixture))
        zip.file(
          'xl/cellimages.xml',
          `<wps:cellImages xmlns:wps="http://www.wps.cn/officeDocument/2017/etCustomData" xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${officeRels}">
      <wps:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr name="ID_photo"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></wps:cellImage>
      <wps:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr name="ID_external"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill></xdr:pic></wps:cellImage>
    </wps:cellImages>`,
        )
        zip.file(
          'xl/_rels/cellimages.xml.rels',
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="${officeRels}/image" Target="media/photo.png"/>
      <Relationship Id="rId2" Type="${officeRels}/image" Target="media/photo.png" TargetMode="External"/>
    </Relationships>`,
        )
        zip.file('xl/media/photo.png', Buffer.from(pixel, 'base64'))
        zip.file(
          sheetPath,
          `<worksheet xmlns="${sheetNs}"><sheetData><row r="2"><c r="A2"/>
      <c r="B2" t="str"><f>_xlfn.DISPIMG(&quot;ID_photo&quot;,1)</f><v>cached image text</v></c>
      <c r="C2" t="e"><f>DISPIMG("ID_photo",1)</f><v>#VALUE!</v></c>
      <c r="D2" t="str"><f>DISPIMG("ID_missing",1)</f><v>missing image</v></c>
      <c r="E2" t="str"><v>DISPIMG("ID_photo",1)</v></c>
      <c r="F2" t="str"><f>DISPIMG("ID_external",1)</f><v>external image</v></c>
    </row>${Array.from({ length: 499 }, (_, i) => {
      const row = i + 3
      return `<row r="${row}"><c t="str"><f>DISPIMG("ID_photo",1)</f><v>image placeholder</v></c></row>`
    }).join('')}</sheetData></worksheet>`,
        )
        const bytes = await zip.generateAsync({ type: 'nodebuffer' })
        const opened = await native.inspect(bytes, undefined, true)
        const images = opened.sheets[0].cellImages
        assert.equal(images.length, 500)
        assert.deepEqual(images.slice(0, 3), [
          { id: 'cell-image-0', row: 1, column: 1 },
          { id: 'cell-image-1', row: 1, column: 2 },
          { id: 'cell-image-2', row: 2, column: 0 },
        ])
        const { cells } = await native.readRange(bytes, 'Acceptance', range)
        for (const image of images.slice(0, 3))
          assert.ok(
            cells
              .filter((cell) => cell.row === image.row && cell.column === image.column)
              .every((cell) => cell.value === null && !cell.formula),
          )
        assert.deepEqual(
          [3, 4, 5].map(
            (column) => cells.find((cell) => cell.row === 1 && cell.column === column).value,
          ),
          ['missing image', 'DISPIMG("ID_photo",1)', 'external image'],
        )
        const formulaCells = (await native.readSheet(bytes, 'Acceptance', 'formulas')).cells
        assert.deepEqual(
          formulaCells.map(({ row, column }) => [row, column]),
          [
            [1, 3],
            [1, 5],
            [500, 0],
          ],
        )
        assert.deepEqual(await native.readMedia(bytes, 'cell-image-1'), {
          mediaType: 'image/png',
          base64: pixel,
        })
        zip.file('xl/media/photo.png', Buffer.alloc(20 * 1024 * 1024 + 1))
        const oversized = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
        await assert.rejects(() => native.readMedia(oversized, 'cell-image-0'))
      },
    )
  },
)
