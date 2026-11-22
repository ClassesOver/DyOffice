import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import JSZip from 'jszip'
import { buildLocalApp } from '../../server/src/app.ts'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createMcpPptxNotes } from '../../server/src/modules/mcp-server/pptx-notes.ts'
import { openIsolatedPptxSession } from '../../worker/src/native/pptx-session-host.ts'
import { fileFixture, importFile } from '../helpers/files.mjs'
import { restrictedOrigin } from '../helpers/restricted.mjs'

const version = '2026-07-28'
const name = 'set_pptx_notes'
const route = '/api/v1/mcp/pptx-notes-grants'

test('approved PPTX notes persist only on their target and replay the same revision', { timeout: 90_000 }, async t => {
  const previousEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnv
  })
  const f = await fileFixture(t, { buildApp: false })
  const open = (input, signal) => openIsolatedPptxSession(input, { timeoutMs: 20_000, unsafeTestOnly: true, signal })
  let writeSessions = 0
  const app = await buildLocalApp({
    db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId,
    origin: restrictedOrigin, csrfKey: f.csrfKey, objectStore: f.objects,
    slidesHost: { openSession(input, signal) { writeSessions++; return open(input, signal) } },
  })
  f.cleanup.unshift(() => app.close())

  const sourceZip = await JSZip.loadAsync(await readFile(new URL('../fixtures/slides/acceptance.pptx', import.meta.url)))
  const neighbor = 'ppt/slides/slide1.xml'
  const neighborXml = await sourceZip.file(neighbor).async('string')
  sourceZip.file(neighbor, neighborXml.replace('xmlns:p=', 'xmlns:alternate=')
    .replace(/<(\/?)(p:)/g, '<$1alternate:')
    .replace('</a:t>', ' literal alternate:label</a:t>'))
  const original = await sourceZip.generateAsync({ type: 'nodebuffer' })
  const { file: { fileId, revision } } = await importFile(f, f.alice.token, original, 'acceptance.pptx')
  const csrf = createCsrfService({ db: f.db, origin: restrictedOrigin, deploymentId: f.deploymentId, key: f.csrfKey })
  const issue = (token, payload) => app.inject({ method: 'POST', url: route, payload,
    headers: { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token) },
  })
  const rpc = async (token, method, params = {}) => (await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream',
      'mcp-protocol-version': version, 'mcp-method': method, ...(params.name && { 'mcp-name': params.name }) },
    payload: { jsonrpc: '2.0', id: 1, method, params: { ...params,
      _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } },
  })).json().result
  const write = (token, args) => rpc(token, 'tools/call', { name, arguments: args })

  const text = 'Approved presenter notes — 讲稿 📎\nSecond line <literal>'
  const args = { fileId, revision, slide: 1, text }
  const issued = await issue(f.alice.token, args)
  assert.equal(issued.statusCode, 201, issued.body)
  assert.equal((await issue(f.bob.token, args)).statusCode, 404)
  for (const invalid of ['\u0000', '\uD800', '\r', '\uFFFE', '\u0001', 'notes\n', '\n\n']) {
    assert.equal((await issue(f.alice.token, { ...args, text: invalid })).statusCode, 400)
  }
  const { token } = issued.json()
  assert.deepEqual((await rpc(token, 'tools/list')).tools.map(tool => tool.name), ['read_saved_document', name])
  const oldHead = await f.files.openFile(f.alice.token, fileId)
  assert.equal((await write(token, { ...args, slide: 0 })).isError, true)
  assert.equal((await write(token, { ...args, text: 'different' })).isError, true)
  assert.equal(writeSessions, 0)
  assert.equal((await f.files.openFile(f.alice.token, fileId)).file.revision, oldHead.file.revision)

  const leases = createLeaseService({ transactions: f.transactions })
  const editorId = randomUUID()
  const { leaseEpoch } = await leases.acquireLease(f.alice.token, fileId, { editorId })
  assert.equal((await write(token, args)).isError, true)
  assert.equal(writeSessions, 0)
  await leases.releaseLease(f.alice.token, fileId, { editorId, leaseEpoch })

  const result = await write(token, args)
  const receipt = result.structuredContent
  assert.ok(receipt, JSON.stringify(result))
  assert.notEqual(receipt.revision, revision)
  assert.deepEqual((await write(token, args)).structuredContent, receipt)
  assert.equal(writeSessions, 1)
  const saved = await f.files.readFile(f.alice.token, fileId, receipt.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token, fileId, revision), original)
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(saved)
  for (const entry of before.file(/^ppt\/(?:slides|slideMasters|slideLayouts)\/[^/]+\.xml$/)) {
    assert.deepEqual(await after.file(entry.name).async('nodebuffer'), await entry.async('nodebuffer'), entry.name)
  }

  const opened = await open({ fileId, revision: receipt.revision, bytes: saved })
  const source = await open({ fileId, revision, bytes: original })
  try {
    assert.equal(await opened.notes(0, 1), text)
    assert.equal(await opened.notes(0, 0), await source.notes(0, 0))
  } finally { opened.close(); source.close() }
  const read = await rpc(token, 'tools/call', { name: 'read_saved_document', arguments: { fileId, revision: receipt.revision } })
  assert.ok(read.structuredContent.text)
  assert.ok(!read.structuredContent.text.includes('Approved presenter notes'))

  async function refusesDraft(zip, filename) {
    const { file } = await importFile(f, f.alice.token, await zip.generateAsync({ type: 'nodebuffer' }), filename)
    const invalidTarget = { ...args, fileId: file.fileId, revision: file.revision, text: 'Do not publish' }
    const grant = await issue(f.alice.token, invalidTarget)
    assert.equal(grant.statusCode, 201, grant.body)
    assert.equal((await write(grant.json().token, invalidTarget)).isError, true, filename)
    assert.equal((await f.files.openFile(f.alice.token, file.fileId)).file.revision, file.revision)
  }
  const shared = await JSZip.loadAsync(saved)
  const firstRels = 'ppt/slides/_rels/slide1.xml.rels'
  const alias = '<Relationship Id="rIdSharedNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/./notesSlide1.xml"/>'
  shared.file(firstRels, (await shared.file(firstRels).async('string')).replace('</Relationships>', alias + '</Relationships>'))
  await refusesDraft(shared, 'shared-notes.pptx')
  const commented = await JSZip.loadAsync(saved)
  const notesPart = 'ppt/notesSlides/notesSlide1.xml'
  const notesXml = await commented.file(notesPart).async('string')
  const phantomBody = '<p:sp><p:ph type="body"/><p:txBody><a:p><a:r><a:t>Old comment</a:t></a:r></a:p></p:txBody></p:sp>'
  commented.file(notesPart, notesXml.replaceAll('<p:sp>', '<p:sp >').replace('<p:spTree>', '<p:spTree><!--' + phantomBody + '-->'))
  const { file: withComment } = await importFile(f, f.alice.token, await commented.generateAsync({ type: 'nodebuffer' }), 'comments.pptx')
  const commentArgs = { ...args, fileId: withComment.fileId, revision: withComment.revision, text: 'Replace only the real notes' }
  const commentGrant = await issue(f.alice.token, commentArgs)
  assert.equal(commentGrant.statusCode, 201, commentGrant.body)
  const commentReceipt = (await write(commentGrant.json().token, commentArgs)).structuredContent
  assert.ok(commentReceipt)
  const commentOutput = await JSZip.loadAsync(await f.files.readFile(f.alice.token, withComment.fileId, commentReceipt.revision))
  const commentOutputXml = await commentOutput.file(notesPart).async('string')
  assert.ok(commentOutputXml.includes('<!--' + phantomBody + '-->'))
  const actualNotes = commentOutputXml.replace(/<!--[\s\S]*?-->/g, '')
  assert.equal([...actualNotes.matchAll(/<p:ph type="body"/g)].length, 1)
  assert.match(actualNotes, /<a:t>Replace only the real notes<\/a:t>/)

  const missing = { fileId, revision: receipt.revision, slide: 999, text }
  const missingGrant = (await issue(f.alice.token, missing)).json()
  assert.equal((await write(missingGrant.token, missing)).isError, true)
  assert.equal((await f.files.openFile(f.alice.token, fileId)).file.revision, receipt.revision)

  const clear = { fileId, revision: receipt.revision, slide: 1, text: '' }
  const clearGrant = await issue(f.alice.token, clear)
  assert.equal(clearGrant.statusCode, 201, clearGrant.body)
  const cleared = (await write(clearGrant.json().token, clear)).structuredContent
  assert.ok(cleared)
  const clearedBytes = await f.files.readFile(f.alice.token, fileId, cleared.revision)
  const clearedSession = await open({ fileId, revision: cleared.revision, bytes: clearedBytes })
  try {
    assert.equal(await clearedSession.notes(0, 1), '')
  } finally { clearedSession.close() }

  const cancelArgs = { ...args, revision: cleared.revision, text: 'Cancelable edit' }
  const cancelGrant = await issue(f.alice.token, cancelArgs)
  assert.equal(cancelGrant.statusCode, 201, cancelGrant.body)
  const entered = Promise.withResolvers()
  const cancelled = createMcpPptxNotes({ transactions: f.transactions, objects: f.objects }, {
    async openSession(input, signal) {
      const handle = await open(input, signal)
      const gate = Promise.withResolvers()
      return { ...handle, apply() { entered.resolve(); return gate.promise },
        close() { handle.close(); gate.reject(new Error('SESSION_CLOSED')) } }
    },
  })
  const controller = new AbortController()
  const tokenToRetry = cancelGrant.json().token
  const inFlight = cancelled({ kind: 'external-token', token: tokenToRetry }, cancelArgs, controller.signal)
  const failed = assert.rejects(inFlight)
  await Promise.race([entered.promise, inFlight.then(() => assert.fail("edit completed before reaching apply"))])
  controller.abort()
  await failed
  assert.equal((await f.files.openFile(f.alice.token, fileId)).file.revision, cleared.revision)
  assert.ok((await write(tokenToRetry, cancelArgs)).structuredContent)
})
