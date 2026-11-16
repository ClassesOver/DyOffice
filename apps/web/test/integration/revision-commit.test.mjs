import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSaveGenerationGuard } from '../../../../packages/browser-host/src/save-generation.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.mjs'
import { createFileJournal, createMemoryJournal } from '../../server/src/modules/revisions/journal.mjs'
import { revisionError } from '../../server/src/modules/revisions/errors.mjs'
import { createStore } from '../../server/store.mjs'
import { rawBody } from '../../server/src/http-helpers.mjs'
import { projectCurrentHead } from '../../server/src/modules/revisions/projection.mjs'
import { handleRevisionRoutes } from '../../server/src/modules/revisions/routes.mjs'
import { createRevisionRuntime, DEV_PERSONAL_PRINCIPAL } from '../../server/src/modules/revisions/runtime.mjs'
import { createRevisionService } from '../../server/src/modules/revisions/service.mjs'
import { createOutboxService } from '../../server/src/outbox/service.mjs'
import { createLocalObjectStore } from '../../server/src/storage/local-dev.mjs'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const ZIP_B = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x01])
const ZIP_C = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x02])
const principal = { ownerId: 'owner-a', deploymentId: 'dep-1', sessionId: 'session-a' }
const otherSession = { ...principal, sessionId: 'session-b' }
const stranger = { ownerId: 'owner-b', deploymentId: 'dep-1', sessionId: 'session-c' }

async function setup(t, now = () => 1_700_000_000_000) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-revisions-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const objects = await createLocalObjectStore({ directory: join(directory, 'objects'), maxObjectBytes: 1024, maxOwnerBytes: 8192 })
  const journal = createMemoryJournal()
  const revisions = createRevisionService({ journal, objects, now })
  const leases = createLeaseService({ journal, now })
  const outbox = createOutboxService(journal)
  const fileId = randomUUID()
  const head = await revisions.registerHead(principal, { fileId, name: 'notes.docx', bytes: ZIP })
  return { directory, objects, journal, revisions, leases, outbox, fileId, head }
}

async function stage(objects, bytes, name = 'notes.docx') {
  return objects.stageUpload({ ownerId: principal.ownerId, name, bytes })
}

function saveInput(fileId, head, uploadId, idempotencyKey, leaseEpoch = 1) {
  return { fileId, uploadId, baseRevision: head.revision, idempotencyKey, leaseEpoch }
}

test('one of two commits from the same base becomes current and the other keeps its draft', async (t) => {
  const { revisions, outbox, objects, fileId, head } = await setup(t)
  const first = await stage(objects, ZIP_B, 'a.docx')
  const second = await stage(objects, ZIP_C, 'b.docx')
  await revisions.noteUpload(principal, { fileId, uploadId: first.uploadId })
  await revisions.noteUpload(principal, { fileId, uploadId: second.uploadId })
  const results = await Promise.allSettled([
    revisions.commitRevision(principal, saveInput(fileId, head, first.uploadId, 'commit-key-a')),
    revisions.commitRevision(principal, saveInput(fileId, head, second.uploadId, 'commit-key-b')),
  ])
  const committed = results.filter((result) => result.status === 'fulfilled')
  const conflicted = results.filter((result) => result.status === 'rejected')
  assert.equal(committed.length, 1)
  assert.equal(conflicted.length, 1)
  assert.equal(conflicted[0].reason.code, 'REVISION_CONFLICT')
  const history = revisions.listRevisions(principal, fileId)
  assert.equal(history.length, 2)
  assert.equal(revisions.current(principal, fileId).revision, committed[0].value.ref.revision)
  assert.equal(outbox.list(principal).length, 1)
  assert.equal(outbox.list(principal)[0].revision, committed[0].value.ref.revision)
  assert.equal(outbox.list(stranger).length, 0)
})

test('a stale lease epoch cannot commit after takeover or expiry', async (t) => {
  const clock = { t: 1_700_000_000_000 }
  const { revisions, leases, objects, fileId, head } = await setup(t, () => clock.t)
  const acquired = await leases.acquireLease(principal, fileId)
  assert.equal(acquired.leaseEpoch, 1)
  await assert.rejects(leases.acquireLease(otherSession, fileId), (error) => error.code === 'LEASE_HELD')
  const taken = await leases.takeoverLease(otherSession, fileId)
  assert.equal(taken.leaseEpoch, 2)
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  await assert.rejects(
    revisions.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'stale-lease-1', 1)),
    (error) => error.code === 'LEASE_CONFLICT',
  )
  assert.equal(revisions.current(principal, fileId).revision, head.revision)
  clock.t += 45_001
  await assert.rejects(
    revisions.commitRevision(otherSession, saveInput(fileId, head, staged.uploadId, 'expired-lease', taken.leaseEpoch)),
    (error) => error.code === 'LEASE_CONFLICT',
  )
  await assert.rejects(leases.renewLease(otherSession, fileId, taken.leaseEpoch), (error) => error.code === 'LEASE_CONFLICT')
  const again = await leases.acquireLease(otherSession, fileId)
  assert.equal(again.leaseEpoch, 3)
  clock.t += 1000
  const renewed = await leases.renewLease(otherSession, fileId, again.leaseEpoch)
  assert.ok(renewed.expiresAt > again.expiresAt)
  const saved = await revisions.commitRevision(otherSession, saveInput(fileId, head, staged.uploadId, 'fresh-lease-1', again.leaseEpoch))
  assert.notEqual(saved.ref.revision, head.revision)
})

test('the same idempotency key with different bytes conflicts and a lost response returns the original revision', async (t) => {
  const { revisions, outbox, objects, fileId, head } = await setup(t)
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  const input = saveInput(fileId, head, staged.uploadId, 'same-key-01')
  const saved = await revisions.commitRevision(principal, input)
  const other = await stage(objects, ZIP_C)
  await revisions.noteUpload(principal, { fileId, uploadId: other.uploadId })
  await assert.rejects(
    revisions.commitRevision(principal, saveInput(fileId, head, other.uploadId, 'same-key-01')),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  )
  const replayUpload = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: replayUpload.uploadId })
  const replay = await revisions.commitRevision(principal, { ...input, uploadId: replayUpload.uploadId, baseRevision: 'sha256:' + 'ab'.repeat(32) })
  assert.equal(replay.replayed, true)
  assert.equal(replay.ref.revision, saved.ref.revision)
  assert.equal(revisions.listRevisions(principal, fileId).length, 2)
  assert.equal(outbox.list(principal).length, 1)
})

test('a durable object is not published when the journal transaction fails, and the retry commits that same object', async (t) => {
  const { revisions, outbox, objects, fileId, head } = await setup(t)
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  const input = saveInput(fileId, head, staged.uploadId, 'retry-key-01')
  await assert.rejects(
    revisions.commitRevision(principal, input, { beforeJournalCommit: () => { throw revisionError('JOURNAL_FAILED', 503) } }),
    (error) => error.code === 'JOURNAL_FAILED',
  )
  assert.equal(revisions.listRevisions(principal, fileId).length, 1)
  assert.equal(outbox.list(principal).length, 0)
  const finished = await objects.finishUpload({ ownerId: principal.ownerId, uploadId: staged.uploadId })
  const bytes = await objects.downloadObject({ ownerId: principal.ownerId, objectId: finished.objectId })
  assert.equal(bytes.sha256, finished.sha256)
  const saved = await revisions.commitRevision(principal, input)
  assert.equal(saved.objectId, finished.objectId)
  for (const row of revisions.listRevisions(principal, fileId)) {
    const opened = await objects.downloadObject({ ownerId: principal.ownerId, objectId: row.objectId })
    assert.equal(opened.sha256, row.sha256)
    assert.equal(opened.bytes.length, row.size)
  }
})

test('a missing object never becomes a revision', async (t) => {
  const { revisions, objects, journal, fileId, head } = await setup(t)
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  const hidden = {
    stageUpload: (input) => objects.stageUpload(input),
    finishUpload: (input) => objects.finishUpload(input),
    downloadObject: async () => {
      throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND', status: 404 })
    },
  }
  const guarded = createRevisionService({ journal, objects: hidden, now: () => 1_700_000_000_000 })
  await assert.rejects(
    guarded.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'missing-object')),
    (error) => error.code === 'HASH_MISMATCH',
  )
  assert.equal(revisions.listRevisions(principal, fileId).length, 1)
})

function responseCapture() {
  let status = 0
  let payload = ''
  return {
    res: {
      writeHead(code) { status = code },
      end(body) { payload = body },
      getHeader() { return undefined },
    },
    result() { return { status, body: JSON.parse(payload) } },
  }
}

test('replaying an older commit through the route projects the current head', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-route-head-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = join(directory, 'files')
  await mkdir(files, { recursive: true })
  const store = await createStore(directory, 'route-head-test')
  const objects = await createLocalObjectStore({ directory: join(directory, 'objects'), maxObjectBytes: 1024, maxOwnerBytes: 8192 })
  const revisionsRuntime = await createRevisionRuntime({ directory, objects })
  const owner = DEV_PERSONAL_PRINCIPAL
  const fileId = randomUUID()
  await writeFile(join(files, fileId), ZIP)
  await store.update((state) => { state.files.push({ id: fileId, name: 'notes.docx', format: 'docx', size: ZIP.length }) })
  const ctx = { store, filePath: files, revisionsRuntime }
  const head = await revisionsRuntime.revisions.registerHead(owner, { fileId, name: 'notes.docx', bytes: ZIP })
  async function stageNoted(bytes, name) {
    const staged = await objects.stageUpload({ ownerId: owner.ownerId, name, bytes })
    await revisionsRuntime.revisions.noteUpload(owner, { fileId, uploadId: staged.uploadId })
    return staged.uploadId
  }
  async function commit(uploadId, baseRevision, idempotencyKey) {
    const captured = responseCapture()
    const body = { fileId, uploadId, baseRevision, idempotencyKey, leaseEpoch: 1 }
    const request = { method: 'POST', [rawBody]: Buffer.from(JSON.stringify(body)) }
    await handleRevisionRoutes(request, captured.res, ctx, { url: new URL(`http://localhost/api/v1/files/${fileId}/commits`), state: store.read() })
    return captured.result()
  }
  const firstId = await stageNoted(ZIP_B, 'a.docx')
  const first = await commit(firstId, head.revision, 'route-replay-a')
  assert.equal(first.status, 200)
  const secondId = await stageNoted(ZIP_C, 'b.docx')
  const second = await commit(secondId, first.body.revision, 'route-replay-b')
  assert.equal(second.status, 200)
  await writeFile(join(files, fileId), ZIP_B)
  const replay = await commit(firstId, head.revision, 'route-replay-a')
  assert.equal(replay.status, 200)
  assert.equal(replay.body.revision, first.body.revision)
  assert.notEqual(replay.body.revision, second.body.revision)
  assert.deepEqual(await readFile(join(files, fileId)), ZIP_C)
  assert.equal(revisionsRuntime.revisions.current(owner, fileId).revision, second.body.revision)
})

test('replaying an older commit does not replace the bytes of the current head', async (t) => {
  const { directory, revisions, objects, journal, fileId, head } = await setup(t)
  const files = join(directory, 'files')
  await mkdir(files, { recursive: true })
  await writeFile(join(files, fileId), ZIP)
  const meta = { files: [{ id: fileId, size: ZIP.length }] }
  const store = { update: async (fn) => { await fn(meta) } }
  const project = () => projectCurrentHead({
    journal, objects, ownerId: principal.ownerId, deploymentId: principal.deploymentId, store, filePath: files, fileId,
  })
  const firstUpload = await stage(objects, ZIP_B, 'a.docx')
  await revisions.noteUpload(principal, { fileId, uploadId: firstUpload.uploadId })
  const first = await revisions.commitRevision(principal, saveInput(fileId, head, firstUpload.uploadId, 'replay-head-a'))
  await project(first)
  const secondUpload = await stage(objects, ZIP_C, 'b.docx')
  await revisions.noteUpload(principal, { fileId, uploadId: secondUpload.uploadId })
  const second = await revisions.commitRevision(principal, saveInput(fileId, first.ref, secondUpload.uploadId, 'replay-head-b'))
  await project(second)
  const replay = await revisions.commitRevision(principal, saveInput(fileId, head, firstUpload.uploadId, 'replay-head-a'))
  assert.equal(replay.replayed, true)
  assert.equal(replay.ref.revision, first.ref.revision)
  await project(replay)
  assert.deepEqual(await readFile(join(files, fileId)), ZIP_C)
  assert.equal(revisions.current(principal, fileId).revision, second.ref.revision)
})

test('restoring from a stale base conflicts and leaves the current head in place', async (t) => {
  const { revisions, outbox, objects, fileId, head } = await setup(t)
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  const saved = await revisions.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'restore-base-edit'))
  await assert.rejects(
    revisions.restoreRevision(principal, {
      fileId,
      sourceRevision: head.revision,
      baseRevision: head.revision,
      leaseEpoch: 1,
      idempotencyKey: 'restore-stale-1',
    }),
    (error) => error.code === 'REVISION_CONFLICT',
  )
  assert.equal(revisions.current(principal, fileId).revision, saved.ref.revision)
  assert.equal(outbox.list(principal).length, 1)
  const restored = await revisions.restoreRevision(principal, {
    fileId,
    sourceRevision: head.revision,
    baseRevision: saved.ref.revision,
    leaseEpoch: 1,
    idempotencyKey: 'restore-fresh-01',
  })
  assert.notEqual(restored.ref.revision, head.revision)
  assert.equal(restored.ref.sha256, head.sha256)
  assert.equal(revisions.current(principal, fileId).revision, restored.ref.revision)
})

test('a journal write failure after the commit decision publishes no revision', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-journal-fail-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const objects = await createLocalObjectStore({ directory: join(directory, 'objects'), maxObjectBytes: 1024, maxOwnerBytes: 8192 })
  let armed = false
  const journal = createMemoryJournal({
    persist: async () => { if (armed) throw Object.assign(new Error('disk'), { code: 'JOURNAL_FAILED' }) },
  })
  const revisions = createRevisionService({ journal, objects, now: () => 1_700_000_000_000 })
  const outbox = createOutboxService(journal)
  const fileId = randomUUID()
  const head = await revisions.registerHead(principal, { fileId, name: 'notes.docx', bytes: ZIP })
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  armed = true
  await assert.rejects(
    revisions.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'disk-fail-key1')),
    (error) => error.code === 'JOURNAL_FAILED',
  )
  assert.equal(revisions.listRevisions(principal, fileId).length, 1)
  assert.equal(outbox.list(principal).length, 0)
  armed = false
  const saved = await revisions.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'disk-fail-key1'))
  assert.equal(saved.replayed, false)
  assert.equal(revisions.listRevisions(principal, fileId).length, 2)
  for (const row of revisions.listRevisions(principal, fileId)) {
    const opened = await objects.downloadObject({ ownerId: principal.ownerId, objectId: row.objectId })
    assert.equal(opened.sha256, row.sha256)
  }
})

test('restoring a historical revision creates a new head and keeps the old object', async (t) => {
  const { revisions, objects, fileId, head } = await setup(t)
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  const saved = await revisions.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'edit-key-001'))
  const restored = await revisions.restoreRevision(principal, {
    fileId,
    sourceRevision: head.revision,
    baseRevision: saved.ref.revision,
    leaseEpoch: 1,
    idempotencyKey: 'restore-key-1',
  })
  assert.notEqual(restored.ref.revision, head.revision)
  assert.equal(restored.ref.sha256, head.sha256)
  assert.equal(revisions.current(principal, fileId).revision, restored.ref.revision)
  const history = revisions.listRevisions(principal, fileId)
  assert.deepEqual(history.map((row) => row.reason), ['import', 'commit', 'restore'])
  const original = await objects.downloadObject({ ownerId: principal.ownerId, objectId: history[0].objectId })
  const copy = await objects.downloadObject({ ownerId: principal.ownerId, objectId: restored.objectId })
  assert.deepEqual(copy.bytes, original.bytes)
  assert.equal(restored.objectId, history[0].objectId)
})

test('a late commit acknowledgement does not mark edits made during the save as saved', async (t) => {
  const { revisions, objects, fileId, head } = await setup(t)
  const guard = createSaveGenerationGuard()
  guard.markEdited()
  const ticket = guard.beginSave()
  guard.markEdited()
  const staged = await stage(objects, ZIP_B)
  await revisions.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  const saved = await revisions.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'generation-key'))
  assert.equal(guard.settleSave(ticket, 'committed'), true)
  assert.equal(guard.getState().dirty, true)
  assert.equal(guard.getState().savedGeneration, 1)
  const lost = createSaveGenerationGuard()
  lost.markEdited()
  const pending = lost.beginSave()
  lost.settleSave(pending, 'unknown')
  const again = await revisions.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'generation-key'))
  assert.equal(again.ref.revision, saved.ref.revision)
  lost.settleSave(pending, 'committed')
  assert.equal(lost.getState().dirty, false)
  assert.equal(lost.getState().status, 'idle')
})

test('another owner cannot read or commit a file, and the file journal replays after reload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-journal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const objects = await createLocalObjectStore({ directory: join(directory, 'objects'), maxObjectBytes: 1024, maxOwnerBytes: 8192 })
  const file = join(directory, 'revision-journal.json')
  const firstJournal = await createFileJournal({ file })
  const first = createRevisionService({ journal: firstJournal, objects, now: () => 5 })
  const fileId = randomUUID()
  const head = await first.registerHead(principal, { fileId, name: 'notes.docx', bytes: ZIP })
  const staged = await stage(objects, ZIP_B)
  await first.noteUpload(principal, { fileId, uploadId: staged.uploadId })
  const saved = await first.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'durable-key1'))
  await assert.rejects(async () => first.listRevisions(stranger, fileId), (error) => error.code === 'NOT_FOUND')
  await assert.rejects(first.commitRevision(stranger, saveInput(fileId, head, staged.uploadId, 'other-owner1')), (error) => error.code === 'NOT_FOUND')
  const reloaded = createRevisionService({ journal: await createFileJournal({ file }), objects, now: () => 6 })
  const replay = await reloaded.commitRevision(principal, saveInput(fileId, head, staged.uploadId, 'durable-key1'))
  assert.equal(replay.ref.revision, saved.ref.revision)
  assert.equal(reloaded.listRevisions(principal, fileId).length, 2)
})

test('revision SQL records leases, idempotency, and outbox, and T04 forces row level security', async () => {
  const sql = await readFile(new URL('../../server/db/migrations/0004_revisions.sql', import.meta.url), 'utf8')
  const names = ['dyoffice_revision_files', 'dyoffice_file_revisions', 'dyoffice_edit_leases', 'dyoffice_revision_idempotency', 'dyoffice_outbox']
  for (const name of names) {
    assert.match(sql, new RegExp(`CREATE TABLE ${name} \\(`))
  }
  assert.match(sql, /PRIMARY KEY \(deployment_id, owner_id, file_id, idempotency_key\)/)
  assert.match(sql, /lease_epoch BIGINT NOT NULL/)
  assert.doesNotMatch(sql, /ENABLE ROW LEVEL SECURITY|CREATE POLICY|(?<!NO)BYPASSRLS/i)
  const rls = await readFile(new URL('../../server/db/migrations/0005_rls.sql', import.meta.url), 'utf8')
  for (const name of names) {
    assert.match(rls, new RegExp(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`))
  }
})
