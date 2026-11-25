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

const source = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships'
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const sheetId = 'sheet-1'
const bounds = { startRow: 0, endRow: 10, startColumn: 0, endColumn: 12 }
const structuralOps = [
  { sheetId, kind: 'insert-rows', index: 0, count: 1 },
  { sheetId, kind: 'insert-cols', index: 0, count: 1 },
]
const legacy = { row: 1, column: 0, author: 'Note author', text: 'Legacy note on A2' }
const thread = {
  row: 3,
  column: 0,
  author: 'Thread author',
  text: 'Thread on A4',
  thread: {
    id: '{11111111-1111-1111-1111-111111111111}',
    personId: '{22222222-2222-2222-2222-222222222222}',
    author: 'Thread author',
    dT: '2026-09-01T08:30:00',
    done: true,
    replies: [
      {
        id: '{33333333-3333-3333-3333-333333333333}',
        personId: '{44444444-4444-4444-4444-444444444444}',
        author: 'Reply author',
        dT: '2026-09-02T08:30:00',
        text: 'Reply on A4',
      },
    ],
  },
}
const picture = {
  mediaType: 'image/png',
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  widthPx: 1,
  heightPx: 1,
  name: 'Note.png',
}

async function externalFixture() {
  const zip = await JSZip.loadAsync(source)
  const add = async (path, change) => zip.file(path, change(await zip.file(path).async('string')))
  const externalPath = 'xl/externalLinks/externalLink1.xml'
  await add('[Content_Types].xml', (xml) =>
    xml.replace(
      '</Types>',
      `<Override PartName="/${externalPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>`,
    ),
  )
  await add('xl/_rels/workbook.xml.rels', (xml) =>
    xml.replace(
      '</Relationships>',
      `<Relationship Id="rId3" Type="${office}/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>`,
    ),
  )
  await add('xl/workbook.xml', (xml) =>
    xml.replace(
      '<calcPr ',
      '<externalReferences><externalReference r:id="rId3"/></externalReferences><calcPr ',
    ),
  )
  zip.file(
    externalPath,
    `<externalLink xmlns="${main}" xmlns:r="${office}"><externalBook r:id="rId1"><sheetNames><sheetName val="Acceptance"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="2"><cell r="A2"><v>42</v></cell></row><row r="8"><cell r="A8"><v>77</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`,
  )
  zip.file(
    'xl/externalLinks/_rels/externalLink1.xml.rels',
    `<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${office}/externalLinkPath" Target="file:///C:/fixture/reference.xlsx" TargetMode="External"/></Relationships>`,
  )
  await add('xl/worksheets/sheet1.xml', (xml) =>
    xml.replace(
      '<c r="F2"><f>SUM(Revenue)</f><v>-1</v></c>',
      '<c r="F2"><f>SUM(Revenue)</f><v>-1</v></c>' +
        '<c r="G2"><f>[1]Acceptance!$A$2</f><v>42</v></c>' +
        '<c r="H2"><f>\'[1]Acceptance\'!$A$2</f><v>42</v></c>' +
        '<c r="I2"><f>Acceptance!$A$2</f><v>12.5</v></c>' +
        '<c r="J2"><f>[1]Acceptance!$A$8</f><v>77</v></c>',
    ),
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

test(
  'Web XLSX shifts existing annotations and keeps external-workbook references unchanged',
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dyoffice-xlsx-structural-annotations-'))
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
    const save = async (bytes, fields) =>
      (
        await native.savePlan(
          bytes,
          await runtime.sheetsWorkbookPlanner(bytes, {
            ...sheetsSaveRequest(sheetId, []),
            ...fields,
          }),
        )
      ).bytes
    const read = (bytes) => native.readRange(bytes, 'Acceptance', bounds)
    const comments = async (bytes) => (await native.inspect(bytes)).sheets[0].comments
    const external = await externalFixture()
    await t.test(
      'preserves quoted and unquoted external formulas as local references move',
      async () => {
        const target = (cells, row, column) =>
          cells.find((cell) => cell.row === row && cell.column === column)?.formula
        const baseline = (await read(external)).cells
        const original = [6, 7, 8, 9].map((col) => target(baseline, 1, col))
        assert.deepEqual(original, [
          '=[1]Acceptance!$A$2',
          "='[1]Acceptance'!$A$2",
          '=Acceptance!$A$2',
          '=[1]Acceptance!$A$8',
        ])
        const saved = await save(external, { structuralOps })
        const cells = (await read(saved)).cells
        const actual = [7, 8, 9, 10].map((col) => target(cells, 2, col))
        assert.deepEqual(actual, [original[0], original[1], '=Acceptance!$B$3', original[3]])
      },
    )
    await t.test(
      'allows local row deletion when a matching reference belongs to an external workbook',
      async () => {
        const deletion = { structuralOps: [{ sheetId, kind: 'remove-rows', index: 7, count: 1 }] }
        const saved = await save(external, deletion)
        const cell = (await read(saved)).cells.find((c) => c.row === 1 && c.column === 9)
        assert.equal(cell.formula, '=[1]Acceptance!$A$8')
        assert.equal(cell.value, 77)
      },
    )
    const seeded = await save(source, {
      noteStates: [{ sheetId, notes: [{ ...legacy, picture }, thread] }],
    })
    const prior = await comments(seeded)
    assert.deepEqual(
      prior.map(({ row, column }) => [row, column]),
      [
        [1, 0],
        [3, 0],
      ],
    )
    assert.match(prior[0].image.id, /\.png$/)
    assert.equal(prior[1].thread.replies.length, 1)
    await t.test('moves existing notes, images and threads in a structural-only save', async () => {
      const saved = await save(seeded, { structuralOps })
      const current = await comments(saved)
      assert.ok(
        (await read(saved)).cells.some((c) => c.row === 2 && c.column === 1 && c.value === 12.5),
      )
      assert.deepEqual(
        current,
        prior.map((note) => ({ ...note, row: note.row + 1, column: note.column + 1 })),
      )
      assert.deepEqual(await native.readMedia(saved, current[0].image.id), {
        mediaType: picture.mediaType,
        base64: picture.base64,
      })
      const zip = await JSZip.loadAsync(saved)
      const threadXml = await zip.file('xl/threadedComments/threadedComment1.xml').async('string')
      const refs = [...threadXml.matchAll(/<threadedComment\b[^>]*\bref="([^"]+)"/g)]
      assert.deepEqual(
        refs.map((match) => match[1]),
        ['B5', 'B5'],
      )
    })
    await t.test(
      'keeps existing note images when a save includes the moved note snapshot',
      async () => {
        const saved = await save(seeded, {
          structuralOps,
          noteStates: [
            {
              sheetId,
              notes: [
                { ...legacy, row: 2, column: 1 },
                { ...thread, row: 4, column: 1 },
              ],
            },
          ],
        })
        const current = await comments(saved)
        assert.deepEqual(
          current.map(({ row, column }) => [row, column]),
          [
            [2, 1],
            [4, 1],
          ],
        )
        assert.equal(current[0].text, legacy.text)
        assert.deepEqual(current[0].image, prior[0].image)
        assert.deepEqual(await native.readMedia(saved, current[0].image.id), {
          mediaType: picture.mediaType,
          base64: picture.base64,
        })
        assert.equal(current[1].thread.replies.length, 1)
      },
    )
  },
)
