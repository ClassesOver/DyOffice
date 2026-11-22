import test from 'node:test'
import assert from 'node:assert/strict'
import { imageDimensions, literalImage, prepareImageContent, fitInside, base64Bytes, imageAltText } from '../../../../packages/browser-host/src/analysis-image.ts'
import { queryResultTable, QUERY_RESULT_MAX_BODY_ROWS } from '../../../../packages/browser-host/src/query-result-content.ts'
import { createAnalysisInsertSkill, ANALYSIS_INSERT_TOOLS } from '../../../../packages/browser-host/src/analysis-insert-skill.ts'
import { assistantToolsForFormat } from '../../../../packages/web-contracts/src/assistant.ts'

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const png = base64Bytes(PNG_1x1)
// Minimal JPEG header: SOI, APP0 (len 16), SOF0 with 3x2 frame.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
const SHA = 'a'.repeat(64)
const RESULT = '11111111-2222-4333-8444-555555555555'
const ARTIFACT = '66666666-7777-4888-8999-000000000000'

test('image headers give the real pixel size and mismatched or foreign bytes are refused', () => {
  assert.deepEqual(imageDimensions(png, 'image/png'), { width: 1, height: 1 })
  assert.deepEqual(imageDimensions(jpeg, 'image/jpeg'), { width: 3, height: 2 })
  assert.throws(() => imageDimensions(png, 'image/jpeg'))
  assert.throws(() => imageDimensions(new TextEncoder().encode('<svg/>'), 'image/png'))
  const content = prepareImageContent(png, 'image/png', 'chart')
  assert.equal(literalImage(content), content)
  assert.throws(() => literalImage({ ...content, width: 2 }), /Unsupported image/)
  assert.throws(() => literalImage({ ...content, alt: 'a\u0001' }))
  assert.throws(() => prepareImageContent(png, 'image/svg+xml', 'x'))
  assert.deepEqual(fitInside(1000, 500, 400, 400), { width: 400, height: 200 })
  assert.deepEqual(fitInside(10, 5, 400, 400), { width: 10, height: 5 })
  assert.deepEqual(fitInside(10, 5, 400, 400, true), { width: 400, height: 200 })
})

const page = (rows, extra = {}) => ({ artifact: { resultId: RESULT, sourceId: 'sales', sourceVersion: 3 }, schema: [
  { name: 'month', type: 'string' }, { name: 'paid', type: 'number', unit: 'CNY' }, { name: 'closed', type: 'boolean' }],
  timezone: 'UTC', rows, offset: 0, nextOffset: null, totalRows: rows.length, sourceTruncated: false, sha256: SHA, ...extra })

test('a frozen query result becomes a literal table with units, typed columns and provenance', () => {
  const table = queryResultTable([page([{ month: '2026-01', paid: 30, closed: true }, { month: '2026-02', paid: 40.5, closed: null }])], {}, 'docx')
  assert.deepEqual(table.rows.slice(0, 3), [['month', 'paid (CNY)', 'closed'], ['2026-01', '30', 'TRUE'], ['2026-02', '40.5', '']])
  assert.deepEqual(table.columnTypes, ['string', 'number', 'boolean'])
  assert.equal(table.headerRows, 1)
  assert.match(table.rows.at(-4)[0], new RegExp(`Source: sales v3; frozen result ${RESULT}; SHA-256 ${SHA}`))
  assert.match(table.rows.at(-3)[0], /Rows inserted: 2 of 2/)
  // PowerPoint keeps notes beside the table instead of as rows.
  const slide = queryResultTable([page([{ month: 'a', paid: 1, closed: false }])], { columns: ['paid', 'month'] }, 'pptx')
  assert.deepEqual(slide.rows, [['paid (CNY)', 'month'], ['1', 'a']])
  assert.equal(slide.provenance.length, 4)
})

test('selection, size and integrity problems refuse the insertion instead of trimming silently', () => {
  const many = Array.from({ length: 800 }, (_, i) => ({ month: String(i), paid: i, closed: false }))
  assert.throws(() => queryResultTable([page(many)], {}, 'xlsx'), /Too large to insert.*Aggregate in SQL/)
  const limited = queryResultTable([page(many, { totalRows: 800 })], { maxRows: 10 }, 'xlsx')
  assert.match(limited.rows.find(row => row[0].startsWith('Rows inserted'))[0], /Rows inserted: 10 of 800 \(790 not inserted\)/)
  assert.throws(() => queryResultTable([page([])], { columns: ['nope'] }), /Unknown or duplicate column/)
  assert.throws(() => queryResultTable([page([]), page([], { sha256: 'b'.repeat(64) })]), /changed while it was being read/)
  const truncated = queryResultTable([page([{ month: 'x', paid: 1, closed: true }], { sourceTruncated: true })], {}, 'docx')
  assert.ok(truncated.rows.some(row => row[0].startsWith('TRUNCATED at the source query limit')))
})

function harness({ format = 'docx', sourceMode = true, coding = true, change } = {}) {
  const applied = [], requests = []
  const target = {
    fileId: 'f', format,
    capture: () => ({ token: 't', fileId: 'f', format, baseRevision: 'r1', leaseEpoch: 1 }),
    async apply(capture, content, artifact, authorized) {
      change?.()
      if (!authorized()) throw new Error('changed')
      applied.push({ content, artifact }); return { status: 'applied_uncommitted', applicationId: 'a' }
    },
  }
  let current = target
  const receipt = { commandId: 'cmd', createdAt: '2026-11-22T00:00:00Z', summary: '', limitations: [], inputs: [], artifacts: [
    { artifactId: ARTIFACT, name: 'monthly.png', mediaType: 'image/png', role: 'chart', sizeBytes: png.length, sha256: SHA, inputResultIds: [], taskId: 't' }] }
  const deliveries = {
    snapshot: () => [{ receipt }],
    async download(commandId, artifactId) {
      assert.equal(commandId, 'cmd'); assert.equal(artifactId, ARTIFACT)
      return { name: 'monthly.png', artifact: receipt.artifacts[0], receipt, bytes: png, current: () => true }
    },
  }
  const skill = createAnalysisInsertSkill({
    format, documents: { current: () => current }, deliveries, disposed: () => false,
    dataResults: () => sourceMode, images: () => coding,
    async request(path) { requests.push(path); return page([{ month: '2026-01', paid: 30, closed: true }]) },
  })
  return { skill, applied, requests, swap: next => { current = next } }
}

test('tools are offered per format and capability, and the contract lets them through', () => {
  assert.deepEqual(harness().skill.tools.map(t => t.name), [ANALYSIS_INSERT_TOOLS.data, ANALYSIS_INSERT_TOOLS.image])
  assert.deepEqual(harness({ format: 'xlsx' }).skill.tools.map(t => t.name), [ANALYSIS_INSERT_TOOLS.data])
  assert.deepEqual(harness({ sourceMode: false, coding: false }).skill.tools, [])
  for (const format of ['docx', 'xlsx', 'pptx']) assert.ok(assistantToolsForFormat(format).has(ANALYSIS_INSERT_TOOLS.data), format)
  assert.ok(assistantToolsForFormat('docx').has(ANALYSIS_INSERT_TOOLS.image))
  assert.ok(!assistantToolsForFormat('xlsx').has(ANALYSIS_INSERT_TOOLS.image))
  assert.ok(!assistantToolsForFormat('pdf').has(ANALYSIS_INSERT_TOOLS.data))
  assert.match(harness().skill.buildContext(), new RegExp(`monthly.png · image/png · artifactId ${ARTIFACT}`))
})

test('insert_data_result reads the frozen snapshot from the server and applies it through the document target', async () => {
  const h = harness()
  const out = await h.skill.executeTool({ id: '1', name: ANALYSIS_INSERT_TOOLS.data, input: { resultId: RESULT.toUpperCase() } })
  assert.equal(out.isError, undefined, out.output)
  assert.equal(out.mutated, true)
  assert.match(out.output, /not saved yet/)
  assert.deepEqual(h.requests, [`/api/v1/workspace/data-results/${RESULT.toUpperCase()}?offset=0&limit=496`])
  assert.deepEqual(h.applied[0].artifact, { artifactId: RESULT, sha256: SHA })
  assert.deepEqual(h.applied[0].content.rows[1], ['2026-01', '30', 'TRUE'])
  const bad = await h.skill.executeTool({ id: '2', name: ANALYSIS_INSERT_TOOLS.data, input: { resultId: 'not-a-uuid' } })
  assert.equal(bad.isError, true)
})

test('insert_analysis_image inserts the verified latest chart with provenance', async () => {
  const h = harness({ format: 'pptx' })
  const out = await h.skill.executeTool({ id: '1', name: ANALYSIS_INSERT_TOOLS.image, input: {} })
  assert.equal(out.isError, undefined, out.output)
  const { content, artifact } = h.applied[0]
  assert.equal(content.kind, 'image')
  assert.equal(content.base64, PNG_1x1)
  assert.equal(content.alt, 'monthly.png')
  assert.ok(content.provenance.some(line => line.includes(`Artifact SHA-256: ${SHA}`)))
  assert.deepEqual(artifact, { artifactId: ARTIFACT, sha256: SHA })
  const missing = await h.skill.executeTool({ id: '2', name: ANALYSIS_INSERT_TOOLS.image, input: { artifactId: RESULT } })
  assert.equal(missing.isError, true)
})

test('a document change during insertion, or no editable target, is reported and nothing is applied', async () => {
  let h
  h = harness({ change: () => h.swap(undefined) })
  const changed = await h.skill.executeTool({ id: '1', name: ANALYSIS_INSERT_TOOLS.data, input: { resultId: RESULT } })
  assert.equal(changed.isError, true)
  assert.equal(h.applied.length, 0)
  const none = harness(); none.swap(undefined)
  const out = await none.skill.executeTool({ id: '2', name: ANALYSIS_INSERT_TOOLS.data, input: { resultId: RESULT } })
  assert.match(out.output, /No editable document/)
  const pdf = harness(); pdf.swap({ fileId: 'f', format: 'pdf' })
  assert.equal((await pdf.skill.executeTool({ id: '3', name: ANALYSIS_INSERT_TOOLS.data, input: { resultId: RESULT } })).isError, true)
})

test('the advertised maxRows always fits a Word or Excel table, and file names become safe alt text', () => {
  const skill = harness().skill
  const max = skill.tools.find(tool => tool.name === ANALYSIS_INSERT_TOOLS.data).inputSchema.properties.maxRows.maximum
  assert.equal(max, QUERY_RESULT_MAX_BODY_ROWS)
  const many = Array.from({ length: 600 }, (_, i) => ({ month: String(i), paid: i, closed: false }))
  for (const format of ['docx', 'xlsx', 'pptx']) assert.equal(queryResultTable([page(many, { totalRows: 600 })], { maxRows: max }, format).rows.slice(1, 1 + max).length, max, format)
  assert.throws(() => queryResultTable([page(many, { totalRows: 600 })], { maxRows: max + 1 }, 'docx'), /Too large/)
  assert.equal(imageAltText('chart\tQ1\u0000.png'), 'chart Q1 .png')
  assert.equal(imageAltText('x'.repeat(5000)).length, 4096)
  assert.doesNotThrow(() => prepareImageContent(png, 'image/png', imageAltText('chart\tQ1.png')))
})
