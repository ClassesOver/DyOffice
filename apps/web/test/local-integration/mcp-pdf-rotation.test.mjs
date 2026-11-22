import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { restrictedOrigin, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'

const management = '/api/v1/mcp/pdf-rotation-grants'
const tool = 'rotate_pdf_pages'
const version = '2026-07-28'
const meta = {
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientCapabilities': {},
}
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } })
const mcpHeaders = (token, method, name) => ({
  authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream',
  'mcp-protocol-version': version, 'mcp-method': method, ...(name && { 'mcp-name': name }),
})
function session(f, token) {
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  return { cookie: '__Host-dyoffice-session=' + token, origin: restrictedOrigin, 'x-csrf-token': csrf.sessionToken(token) }
}
async function source(f) {
  const doc = await PDFDocument.create()
  doc.addPage([300, 400]).drawText('Original page 1', { x: 30, y: 320, size: 12 })
  doc.addPage([500, 600]).drawText('Original page 2', { x: 30, y: 490, size: 12 })
  const bytes = Buffer.from(await doc.save())
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, bytes, 'rotate.pdf')
  return { bytes, fileId, revision }
}
const argsFor = ({ fileId, revision }) => ({ fileId, revision, pages: [2], degrees: 90 })
const issue = (f, token, payload) => f.app.inject({ method: 'POST', url: management, headers: session(f, token), payload })
const call = (f, token, args) => f.app.inject({
  method: 'POST', url: '/mcp', headers: mcpHeaders(token, 'tools/call', tool),
  payload: rpc('tools/call', { name: tool, arguments: args }),
})
const fail = reply => reply.json().result?.isError === true

test('MCP rotates and saves exactly the approved PDF pages, then returns the same committed revision on retry', async t => {
  const f = await fileFixture(t)
  const original = await source(f)
  const args = argsFor(original)
  const owner = f.alice.token
  const wrongFile = await f.app.inject({ method: 'POST', url: management, headers: session(f, f.bob.token), payload: args })
  assert.equal(wrongFile.statusCode, 404)
  assert.equal((await issue(f, owner, { ...args, revision: randomUUID() })).statusCode, 409)
  const readGrant = (await f.app.inject({ method: 'POST', url: '/api/v1/mcp/read-grants', headers: session(f, owner), payload: { fileId: args.fileId, revision: args.revision } })).json()
  assert.ok(fail(await call(f, readGrant.token, args)))

  const response = await issue(f, owner, args)
  assert.equal(response.statusCode, 201, response.body)
  assert.match(response.headers['cache-control'], /no-store/)
  const grant = response.json()
  const list = await f.app.inject({ method: 'POST', url: '/mcp', headers: mcpHeaders(grant.token, 'tools/list'), payload: rpc('tools/list') })
  assert.deepEqual(list.json().result.tools.map(entry => entry.name), ['read_saved_document', tool])
  assert.ok(fail(await call(f, grant.token, { ...args, degrees: -90 })))
  assert.ok(fail(await call(f, grant.token, { ...args, pages: [1] })))
  assert.equal((await f.files.openFile(owner, args.fileId)).file.revision, args.revision)
  const { createLeaseService } = await import('../../server/src/modules/leases/service.ts')
  const leases = createLeaseService(f)
  const editorId = randomUUID()
  const { leaseEpoch } = await leases.acquireLease(owner, args.fileId, { editorId })
  assert.ok(fail(await call(f, grant.token, args)))
  await leases.releaseLease(owner, args.fileId, { editorId, leaseEpoch })
  const result = await call(f, grant.token, args)
  assert.equal(result.statusCode, 200)
  const receipt = result.json().result.structuredContent
  assert.ok(receipt, result.body)
  assert.notEqual(receipt.revision, args.revision)
  const reopened = await PDFDocument.load(await f.files.readFile(owner, args.fileId, receipt.revision))
  assert.deepEqual(reopened.getPages().map(page => [page.getWidth(), page.getRotation().angle]), [[300, 0], [500, 90]])
  assert.deepEqual(await f.files.readFile(owner, args.fileId, args.revision), original.bytes)
  assert.deepEqual((await call(f, grant.token, args)).json().result.structuredContent, receipt)
  const readResult = credential => f.app.inject({
    method: 'POST', url: '/mcp', headers: mcpHeaders(credential, 'tools/call', 'read_saved_document'),
    payload: rpc('tools/call', { name: 'read_saved_document', arguments: { fileId: args.fileId, revision: receipt.revision } }),
  })
  const resultText = (await readResult(grant.token)).json().result
  assert.match(resultText.structuredContent?.text ?? '', /Original page 2/)
  assert.ok(fail(await readResult(readGrant.token)))
  const history = await f.transactions.withPrincipalTransaction({ kind: 'session', token: owner }, connection =>
    connection.query('SELECT id FROM file_revisions WHERE file_id=$1', [args.fileId]))
  assert.equal(history.rowCount, 2)
  await f.app.inject({ method: 'DELETE', url: '/api/v1/mcp/read-grants/' + grant.id, headers: session(f, owner) })
  assert.equal((await call(f, grant.token, args)).statusCode, 401)
})

test('a browser save using the same idempotency key cannot manufacture an MCP receipt or reveal that revision', async t => {
  const f = await fileFixture(t)
  const args = argsFor(await source(f))
  const grant = (await issue(f, f.alice.token, args)).json()
  assert.ok(grant.token)
  const { createLeaseService } = await import('../../server/src/modules/leases/service.ts')
  const { mcpPdfRotationKey } = await import('../../server/src/db/context.ts')
  const editorId = randomUUID()
  const leases = createLeaseService(f)
  const { leaseEpoch } = await leases.acquireLease(f.alice.token, args.fileId, { editorId })
  const externalSave = await f.app.inject({
    method: 'POST', url: `/api/v1/files/${args.fileId}/pdf/page-ops`,
    headers: session(f, f.alice.token),
    payload: {
      baseRevision: args.revision, editorId, leaseEpoch,
      idempotencyKey: mcpPdfRotationKey(grant.id),
      operations: [{ op: 'rotatePages', pages: [1], dir: 180 }],
    },
  })
  assert.equal(externalSave.statusCode, 200, externalSave.body)
  await leases.releaseLease(f.alice.token, args.fileId, { editorId, leaseEpoch })
  assert.ok(fail(await call(f, grant.token, args)))
  const read = await f.app.inject({
    method: 'POST', url: '/mcp', headers: mcpHeaders(grant.token, 'tools/call', 'read_saved_document'),
    payload: rpc('tools/call', { name: 'read_saved_document', arguments: { fileId: args.fileId, revision: externalSave.json().revision } }),
  })
  assert.ok(fail(read), read.body)
})

test('disconnect during verification of the staged PDF rolls back the write and leaves it safe to retry', { timeout: 30_000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const closed = Promise.withResolvers()
  let pauseVerify = false
  const f = await fileFixture(t, { wrapObjects: store => ({
    ...store,
    async verifyObject(reference) {
      if (pauseVerify) {
        entered.resolve()
        await release.promise
      }
      return store.verifyObject(reference)
    },
  }) })
  const args = argsFor(await source(f))
  const grant = (await issue(f, f.alice.token, args)).json()
  assert.ok(grant.token)
  const endpoint = new URL('/mcp', await f.app.listen({ host: '127.0.0.1', port: 0 }))
  const controller = new AbortController()
  f.app.server.on('request', (request, response) => {
    if (request.url === '/mcp') response.once('close', () => closed.resolve())
  })
  pauseVerify = true
  const request = assert.rejects(fetch(endpoint, {
    method: 'POST', headers: { ...mcpHeaders(grant.token, 'tools/call', tool), 'content-type': 'application/json' },
    body: JSON.stringify(rpc('tools/call', { name: tool, arguments: args })), signal: controller.signal,
  }), { name: 'AbortError' })
  try {
    await entered.promise
    controller.abort()
    await request
    await closed.promise
  } finally {
    pauseVerify = false
    release.resolve()
  }
  const { setTimeout } = await import('node:timers/promises')
  const limit = AbortSignal.timeout(8000)
  while (true) {
    const leases = await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, connection =>
      connection.query('SELECT 1 FROM edit_leases WHERE file_id=$1 AND expires_at>clock_timestamp()', [args.fileId]))
    if (!leases.rowCount) break
    await setTimeout(25, undefined, { signal: limit })
  }
  assert.equal((await f.files.openFile(f.alice.token, args.fileId)).file.revision, args.revision)
  const retry = (await call(f, grant.token, args)).json().result.structuredContent
  assert.ok(retry?.revision)
  assert.notEqual(retry.revision, args.revision)
})

test('a 2025-11-25 SDK client saves the PDF and recovers its receipt over a new connection', { timeout: 30_000 }, async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const f = await fileFixture(t)
  const args = argsFor(await source(f))
  const grant = (await issue(f, f.alice.token, args)).json()
  assert.ok(grant.token)
  const base = await f.app.listen({ host: '127.0.0.1', port: 0 })
  async function connect() {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), {
      requestInit: { headers: { authorization: 'Bearer ' + grant.token } },
    })
    const client = new Client({ name: 'dyoffice-pdf-sdk', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(transport)
    return { client, transport }
  }
  const first = await connect()
  assert.ok((await first.client.listTools()).tools.some(entry => entry.name === tool))
  const receipt = (await first.client.callTool({ name: tool, arguments: args })).structuredContent
  assert.ok(receipt?.revision)
  await first.transport.terminateSession()
  await first.client.close()
  const second = await connect()
  assert.deepEqual((await second.client.callTool({ name: tool, arguments: args })).structuredContent, receipt)
  const resultBytes = await f.files.readFile(f.alice.token, args.fileId, receipt.revision)
  assert.equal((await PDFDocument.load(resultBytes)).getPage(1).getRotation().angle, 90)
  await second.transport.terminateSession()
  await second.client.close()
})

test('a concurrent replay waits for publication and returns the same receipt without reclaiming unrelated uploads', { timeout: 30_000 }, async t => {
  const verified = Promise.withResolvers()
  const release = Promise.withResolvers()
  const removed = []
  let pauseVerify = false
  const f = await fileFixture(t, { wrapObjects: store => ({
    ...store,
    async verifyObject(reference) {
      if (pauseVerify) {
        verified.resolve()
        await release.promise
      }
      return store.verifyObject(reference)
    },
    removeUnreferenced(key) {
      removed.push(key)
      return store.removeUnreferenced(key)
    },
  }) })
  const original = await source(f)
  const args = argsFor(original)
  const owner = f.alice.token
  const abandoned = await f.files.stageUpload(owner, { name: 'unrelated.pdf', size: original.bytes.length })
  await f.files.receiveUpload(owner, abandoned.uploadId, original.bytes)
  await f.files.cancelUpload(owner, abandoned.uploadId)
  const grant = (await issue(f, owner, args)).json()
  assert.ok(grant.token)

  pauseVerify = true
  const first = call(f, grant.token, args)
  let second
  try {
    await verified.promise
    second = call(f, grant.token, args)
    await waitForDatabaseLock(f, 'business')
  } finally {
    pauseVerify = false
    release.resolve()
  }
  const [a, b] = await Promise.all([first, second])
  assert.ok(a.json().result.structuredContent?.revision, a.body)
  assert.deepEqual(b.json().result.structuredContent, a.json().result.structuredContent)
  assert.deepEqual(removed, [])
  const metadata = await f.transactions.withPrincipalTransaction({ kind: 'session', token: owner }, connection =>
    connection.query('SELECT reclaimed_at FROM uploads WHERE id=$1', [abandoned.uploadId]))
  assert.equal(metadata.rows[0].reclaimed_at, null)
})

test('legacy explicit cancellation reaches the handler during publication and rolls back the PDF write', { timeout: 30_000 }, async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const verified = Promise.withResolvers(), release = Promise.withResolvers()
  let pauseVerify = false
  const f = await fileFixture(t, { wrapObjects: store => ({
    ...store,
    async verifyObject(reference) {
      if (pauseVerify) {
        verified.resolve()
        await release.promise
      }
      return store.verifyObject(reference)
    },
  }) })
  const args = argsFor(await source(f))
  const grant = (await issue(f, f.alice.token, args)).json()
  const base = await f.app.listen({ host: '127.0.0.1', port: 0 })
  const url = new URL('/mcp', base)
  const access = { authorization: 'Bearer ' + grant.token }
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: access } })
  const client = new Client({ name: 'dyoffice-pdf-cancel', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(transport)
  const headers = { ...access, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25', 'mcp-session-id': transport.sessionId }
  const { setTimeout } = await import('node:timers/promises')
  pauseVerify = true
  const active = fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 707, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(12000),
  })
  try {
    await Promise.race([
      verified.promise,
      active.then(() => assert.fail('The write finished before verification was paused')),
      setTimeout(8000, undefined, { ref: false }).then(() => assert.fail('Rotation did not begin')),
    ])
    const cancellation = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 707 } }),
      signal: AbortSignal.timeout(3500),
    })
    assert.equal(cancellation.status, 202)
  } finally {
    pauseVerify = false
    release.resolve()
    const response = await active.catch(() => undefined)
    await response?.body?.cancel()
    await client.close()
  }
  const limit = AbortSignal.timeout(8000)
  while (true) {
    const leases = await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, connection =>
      connection.query('SELECT 1 FROM edit_leases WHERE file_id=$1 AND expires_at>clock_timestamp()', [args.fileId]))
    if (!leases.rowCount) break
    await setTimeout(25, undefined, { signal: limit })
  }
  assert.equal((await f.files.openFile(f.alice.token, args.fileId)).file.revision, args.revision)
})
