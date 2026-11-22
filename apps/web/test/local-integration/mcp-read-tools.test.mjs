import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { backgroundDocumentBytes } from '../helpers/background-documents.mjs'
import { fileFixture, importFile } from '../helpers/files.mjs'

test('office MCP reader returns saved content across four formats without creating revisions', async t => {
  const f = await fileFixture(t, { buildApp: false })
  const { createOfficeReadTool, officeReadDescriptor } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const read = createOfficeReadTool(f.files)
  assert.equal(officeReadDescriptor.effect, 'read')
  assert.equal(officeReadDescriptor.requiresActiveEditor, false)
  assert.deepEqual(officeReadDescriptor.requiredScopes, ['files:read'])

  for (const format of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const marker = `Confidential ${format} balance 42`
    const imported = await importFile(f, f.alice.token, await backgroundDocumentBytes(format, marker), `saved.${format}`)
    const { fileId, revision } = imported.file
    const input = { fileId, revision }
    const result = await read(f.alice.token, input, new AbortController().signal)
    assert.deepEqual({ fileId: result.fileId, revision: result.revision, format: result.format }, { fileId, revision, format })
    assert.ok(result.text.includes(marker), `Saved ${format} text was missing`)
    if (format === 'xlsx') assert.match(result.text, /123/)
    assert.equal(result.truncated, false)
    assert.deepEqual((await f.files.openFile(f.alice.token, fileId)).file, imported.file)
    await assert.rejects(() => read(f.bob.token, input, new AbortController().signal), { statusCode: 404 })
  }
})

test('office MCP reader enforces the precise saved revision and refuses trashed documents', async t => {
  const f = await fileFixture(t, { buildApp: false })
  const { createOfficeReadTool } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const read = createOfficeReadTool(f.files)
  const signal = new AbortController().signal
  const bytes = await backgroundDocumentBytes('pdf', 'Original saved document')
  const { file: original } = await importFile(f, f.alice.token, bytes, 'original.pdf')
  const { file: another } = await importFile(f, f.alice.token, bytes, 'another.pdf')
  const { fileId, revision } = original

  await assert.rejects(() => read(f.alice.token, { fileId }, signal), { statusCode: 400 })
  await assert.rejects(() => read(f.alice.token, { fileId, revision, path: '/etc/passwd' }, signal), { statusCode: 400 })
  await assert.rejects(() => read(f.alice.token, { fileId, revision: randomUUID() }, signal), { statusCode: 404 })
  await assert.rejects(() => read(f.alice.token, { fileId, revision: another.revision }, signal), { statusCode: 404 })
  await assert.rejects(() => read(f.alice.token, { fileId, revision }, AbortSignal.abort()), { name: 'AbortError' })
  await f.files.trashFile(f.alice.token, fileId)
  await assert.rejects(() => read(f.alice.token, { fileId, revision }, signal), { statusCode: 404 })
})

test('office MCP reader distinguishes a superseded saved revision from the current revision', async t => {
  const reads = []
  const f = await fileFixture(t, { buildApp: false, wrapObjects: store => ({
    ...store,
    readVerified(reference, signal) {
      reads.push(reference.sha256)
      return store.readVerified(reference, signal)
    },
  }) })
  const { createOfficeReadTool } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const { createLeaseService } = await import('../../server/src/modules/leases/service.ts')
  const { createRevisionService } = await import('../../server/src/modules/revisions/service.ts')
  const leases = createLeaseService({ transactions: f.transactions })
  const revisions = createRevisionService(f)
  const read = createOfficeReadTool(f.files)
  const token = f.alice.token

  const { file: original } = await importFile(f, token, await backgroundDocumentBytes('docx', 'Original budget 42'))
  const { fileId, revision: baseRevision } = original
  const editorId = randomUUID()
  const { leaseEpoch } = await leases.acquireLease(token, fileId, { editorId })
  const updatedBytes = await backgroundDocumentBytes('docx', 'Revised budget 73')
  const { uploadId } = await revisions.stageUpload(token, fileId, { size: updatedBytes.length, baseRevision, editorId, leaseEpoch })
  await f.files.receiveUpload(token, uploadId, updatedBytes)
  const saved = await revisions.commitRevision(token, { fileId, uploadId, baseRevision, leaseEpoch, idempotencyKey: randomUUID() })

  // Legacy revisions lack a persisted signature check. Reading history must
  // still need only the historical bytes, even when the current head is legacy.
  await f.ownerDb.transaction(async connection => {
    await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)", [f.deploymentId, f.alice.user.id])
    await connection.query('UPDATE file_revisions SET office_signature_protected=NULL WHERE id=$1', [saved.revision])
  })
  const signal = new AbortController().signal
  reads.length = 0
  const previous = await read(token, { fileId, revision: baseRevision }, signal)
  assert.deepEqual(reads, [original.sha256])
  const current = await read(token, { fileId, revision: saved.revision }, signal)
  assert.match(previous.text, /Original budget 42/)
  assert.doesNotMatch(previous.text, /Revised budget 73/)
  assert.match(current.text, /Revised budget 73/)
  assert.deepEqual((await f.files.openFile(token, fileId)).file, saved)
})

test('office MCP reader discards extracted text if authority is revoked before responding', async t => {
  const f = await fileFixture(t, { buildApp: false })
  const { createOfficeReadTool } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const token = f.alice.token
  const { file: { fileId, revision } } = await importFile(f, token, await backgroundDocumentBytes('docx'))

  let rechecked = false
  const read = createOfficeReadTool({
    download: f.files.download,
    async assertReadableRevision(...args) {
      rechecked = true
      await f.sessions.logout(token)
      return f.files.assertReadableRevision(...args)
    },
  })

  await assert.rejects(() => read(token, { fileId, revision }, new AbortController().signal), { statusCode: 401 })
  assert.equal(rechecked, true)
})

test('office MCP cancellation reaches an in-progress verified object read', async t => {
  const controller = new AbortController()
  const cancelled = Promise.withResolvers()
  const reading = Promise.withResolvers()
  let pauseRead = false
  const f = await fileFixture(t, { buildApp: false, wrapObjects: store => ({
    ...store,
    async readVerified(reference, signal) {
      if (!pauseRead) return store.readVerified(reference, signal)
      reading.resolve()
      if (!signal) throw Error('Expected the Office tool deadline to reach object storage')
      if (signal.aborted) throw signal.reason
      signal.addEventListener('abort', () => cancelled.reject(signal.reason), { once: true })
      return cancelled.promise
    },
  }) })
  const { createOfficeReadTool } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const token = f.alice.token
  const { file: { fileId, revision } } = await importFile(f, token, await backgroundDocumentBytes('docx'))
  pauseRead = true

  const result = assert.rejects(() => createOfficeReadTool(f.files)(token, { fileId, revision }, controller.signal), { name: 'AbortError' })
  await reading.promise
  controller.abort()
  await result
})

test('office MCP cancellation settles the call while a final access recheck is still pending', async () => {
  const { createOfficeReadTool } = await import('../../server/src/modules/mcp-server/office-read.ts')
  const controller = new AbortController()
  const checking = Promise.withResolvers()
  const blocked = Promise.withResolvers()
  const read = createOfficeReadTool({
    async download() {
      return { bytes: await backgroundDocumentBytes('docx'), format: 'docx' }
    },
    async assertReadableRevision() {
      checking.resolve()
      return blocked.promise
    },
  })
  const result = read('unused-test-credential', { fileId: randomUUID(), revision: randomUUID() }, controller.signal)
  await checking.promise
  controller.abort()
  // Check within the next turn, before the outstanding DB-like work finishes.
  const outcome = await Promise.race([
    result.then(() => 'returned-text', error => error.name),
    new Promise(resolve => setImmediate(() => resolve('still-pending'))),
  ])
  blocked.resolve()
  await result.catch(() => {})
  assert.equal(outcome, 'AbortError')
})
