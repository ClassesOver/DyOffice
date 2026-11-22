import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { buildLocalApp } from '../../server/src/app.ts'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { restrictedOrigin } from '../helpers/restricted.mjs'

const route = '/api/v1/mcp/xlsx-cell-grants'
const name = 'set_xlsx_cells'
const version = '2026-07-28'
const worksheet = 'xl/worksheets/sheet1.xml'
const workbook = 'xl/workbook.xml'
const csrfHeaders = (f, token) => ({
  origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token,
  'x-csrf-token': createCsrfService({ db: f.db, origin: restrictedOrigin, deploymentId: f.deploymentId, key: f.csrfKey }).sessionToken(token),
})
const rpc = (app, token, method, params = {}) => app.inject({
  method: 'POST', url: '/mcp',
  headers: {
    authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream',
    'mcp-protocol-version': version, 'mcp-method': method, ...(params.name && { 'mcp-name': params.name }),
  },
  payload: { jsonrpc: '2.0', id: 1, method, params: { ...params,
    _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} },
  } },
})
const write = (app, token, args) => rpc(app, token, 'tools/call', { name, arguments: args })
const toolResult = reply => reply.json().result

test('MCP approved XLSX cells produce a native saved workbook and one durable revision', { timeout: 60_000 }, async t => {
  const f = await fileFixture(t, { buildApp: false })
  await buildSheetsGateway(join(f.directory, 'gateway.mjs'))
  const wasiRunner = process.env.DYOFFICE_TEST_XLSX_WASI_REFRESH_RUNNER
  const runtime = await configuredSheetsRuntime({
    DYOFFICE_AUTH_MODE: 'local', DYOFFICE_DEPLOYMENT_ID: f.deploymentId,
    DYOFFICE_XLSX_NODE_ENGINE: join(f.directory, 'xlsx-node-engine.mjs'),
    DYOFFICE_XLSX_GATEWAY_RUNNER: join(f.directory, 'gateway-process.mjs'),
    ...(wasiRunner && { DYOFFICE_XLSX_WASI_REFRESH_RUNNER: wasiRunner, DYOFFICE_SANDBOX_MODE: 'subprocess' }),
  }, { enabled: true })
  f.cleanup.unshift(() => runtime.close())
  const app = await buildLocalApp({
    db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId,
    origin: restrictedOrigin, csrfKey: f.csrfKey, objectStore: f.objects,
    sheetsNative: runtime.sheetsNative, sheetsPlanner: runtime.sheetsPlanner, sheetsWorkbookPlanner: runtime.sheetsWorkbookPlanner,
  })
  f.cleanup.unshift(() => app.close())
  const original = await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url))
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, original, 'acceptance.xlsx')
  const cells = [
    { sheetId: 'sheet-1', row: 1, column: 0, value: 21.25 },
    { sheetId: 'sheet-1', row: 2, column: 7, value: '=SUM(A1:A2)' },
    { sheetId: 'sheet-1', row: 3, column: 7, value: true },
    { sheetId: 'sheet-1', row: 1, column: 3, value: null },
  ]
  const args = { fileId, revision, cells }
  const issue = (token, payload) => app.inject({ method: 'POST', url: route, headers: csrfHeaders(f, token), payload })
  assert.equal((await issue(f.bob.token, args)).statusCode, 404)
  assert.equal((await issue(f.alice.token, { ...args, cells: [...cells, cells[0]] })).statusCode, 400)
  for (const value of ['\u0000', '\uD800']) {
    assert.equal((await issue(f.alice.token, { ...args, cells: [{ ...cells[0], value }] })).statusCode, 400)
  }
  const readonly = (await app.inject({ method: 'POST', url: '/api/v1/mcp/read-grants', headers: csrfHeaders(f, f.alice.token), payload: { fileId, revision } })).json()
  assert.equal(toolResult(await write(app, readonly.token, args)).isError, true)
  const issued = await issue(f.alice.token, args)
  assert.equal(issued.statusCode, 201, issued.body)
  const grant = issued.json()
  assert.deepEqual(toolResult(await rpc(app, grant.token, 'tools/list')).tools.map(tool => tool.name), ['read_saved_document', name])
  assert.equal(toolResult(await write(app, grant.token, { ...args, cells: [{ ...cells[0], value: 999 }, ...cells.slice(1)] })).isError, true)
  assert.equal((await f.files.openFile(f.alice.token, fileId)).file.revision, revision)

  const result = toolResult(await write(app, grant.token, args))
  assert.ok(result.structuredContent, JSON.stringify(result.content))
  const receipt = result.structuredContent
  assert.notEqual(receipt.revision, revision)
  assert.deepEqual(toolResult(await write(app, grant.token, { ...args, cells: [...cells].reverse() })).structuredContent, receipt)
  const output = await f.files.readFile(f.alice.token, fileId, receipt.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token, fileId, revision), original)
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(output)
  const xml = await after.file(worksheet).async('string')
  assert.match(xml, /<c r="A2"[^>]*><v>21\.25<\/v><\/c>/)
  assert.match(xml, /<c r="B2"[^>]*><f>A2\*2<\/f>/)
  assert.match(xml, /<c r="H3"[^>]*t="inlineStr"><is><t[^>]*>=SUM\(A1:A2\)<\/t>/)
  assert.match(xml, /<c r="H4"[^>]*t="b"><v>1<\/v><\/c>/)
  assert.doesNotMatch(xml, /<c r="D2"[^>]*><v>0\.125<\/v>/)
  assert.match(await after.file(workbook).async('string'), /fullCalcOnLoad="1"/)
  assert.deepEqual(await after.file('customXml/t09-preserve.xml').async('nodebuffer'), await before.file('customXml/t09-preserve.xml').async('nodebuffer'))
  const range = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }
  if (wasiRunner) {
    const computed = await runtime.sheetsNative.recalculate(output, { edits: [], reads: [{ sheetName: 'Acceptance', range }] })
    assert.ok(computed.cells.some(cell => cell.row === 1 && cell.column === 1 && cell.number === 42.5 && cell.isFormula), JSON.stringify(computed))
  } else {
    assert.equal(runtime.sheetsNative.recalculate, undefined)
  }
  const reopened = await runtime.sheetsNative.readRange(output, 'Acceptance', { ...range, startColumn: 0, endColumn: 0 })
  assert.ok(reopened.cells.some(cell => cell.row === 1 && cell.column === 0 && cell.value === 21.25), JSON.stringify(reopened))
  const read = toolResult(await rpc(app, grant.token, 'tools/call', { name: 'read_saved_document', arguments: { fileId, revision: receipt.revision } }))
  assert.match(read.structuredContent.text, /21\.25/)
  const history = await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, connection =>
    connection.query('SELECT id FROM file_revisions WHERE file_id=$1', [fileId]))
  assert.equal(history.rowCount, 2)

  async function rejectsWorkbook(zip, filename) {
    const { file } = await importFile(f, f.alice.token, await zip.generateAsync({ type: 'nodebuffer' }), filename)
    const unsafeArgs = { fileId: file.fileId, revision: file.revision, cells }
    const unsafeGrant = (await issue(f.alice.token, unsafeArgs)).json()
    assert.ok(unsafeGrant.token)
    assert.equal(toolResult(await write(app, unsafeGrant.token, unsafeArgs)).isError, true, filename)
    assert.equal((await f.files.openFile(f.alice.token, file.fileId)).file.revision, file.revision)
  }
  const ambiguous = await JSZip.loadAsync(original)
  const sourceXml = await ambiguous.file(worksheet).async('string')
  ambiguous.file(worksheet, sourceXml.replace('<sheetData>', '<sheetData><!-- <row r="2"><c r="A2"><v>1</v></c></row> -->'))
  await rejectsWorkbook(ambiguous, 'ambiguous.xlsx')

  const aliased = await JSZip.loadAsync(original)
  const relsPath = 'xl/_rels/workbook.xml.rels'
  const alias = '<Relationship Id="rIdAlias" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="./worksheets/sheet1.xml"/>'
  aliased.file(relsPath, (await aliased.file(relsPath).async('string')).replace('</Relationships>', alias + '</Relationships>'))
  aliased.file(workbook, (await aliased.file(workbook).async('string')).replace('</sheets>', '<sheet name="Alias" sheetId="1000" r:id="rIdAlias"/></sheets>'))
  await rejectsWorkbook(aliased, 'alias.xlsx')
})
