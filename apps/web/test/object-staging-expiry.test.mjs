import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalObjectStore } from '../server/src/storage/local-dev.mjs'

const DOCX = (fill) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(28, fill)])
const HOUR = 60 * 60 * 1000

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-staging-expiry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let clock = Date.parse('2026-11-16T00:00:00Z')
  const store = await createLocalObjectStore({
    directory, maxObjectBytes: 32, maxOwnerBytes: 64, stagedUploadTtlMs: HOUR, now: () => clock, ...extra,
  })
  return { directory, store, advance: (ms) => { clock += ms } }
}

const exists = (path) => access(path).then(() => true, () => false)

test('an abandoned staged upload stops holding quota once it expires', async (t) => {
  const { store, advance } = await fixture(t)
  await store.stageUpload({ ownerId: 'owner-a', name: 'a.docx', bytes: DOCX(1) })
  await store.stageUpload({ ownerId: 'owner-a', name: 'b.docx', bytes: DOCX(2) })
  // Quota is full while both unfinished uploads are fresh.
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'c.docx', bytes: DOCX(3) }), { code: 'QUOTA' })
  advance(HOUR + 1)
  const staged = await store.stageUpload({ ownerId: 'owner-a', name: 'c.docx', bytes: DOCX(3) })
  assert.equal(staged.finished, false)
})

test('an expired staged upload cannot be finished and its unshared blob is removed', async (t) => {
  const { directory, store, advance } = await fixture(t)
  const lost = await store.stageUpload({ ownerId: 'owner-a', name: 'a.docx', bytes: DOCX(1) })
  const shared = await store.stageUpload({ ownerId: 'owner-a', name: 'b.docx', bytes: DOCX(2) })
  const keeper = await store.stageUpload({ ownerId: 'owner-b', name: 'b.docx', bytes: DOCX(2) })
  advance(HOUR / 2)
  await store.finishUpload({ ownerId: 'owner-b', uploadId: keeper.uploadId })
  advance(HOUR / 2 + 1)
  await assert.rejects(store.finishUpload({ ownerId: 'owner-a', uploadId: lost.uploadId }), { code: 'NOT_FOUND' })
  // A later upload sweeps the owner's expired records.
  await store.stageUpload({ ownerId: 'owner-a', name: 'c.docx', bytes: DOCX(3) })
  assert.equal(await exists(join(directory, 'blobs', lost.sha256)), false, 'unshared expired blob removed')
  assert.equal(await exists(join(directory, 'blobs', shared.sha256)), true, 'blob still used by owner-b object kept')
  const records = await readdir(join(directory, 'staging', 'owner-a'))
  assert.equal(records.length, 1, 'only the fresh staging record remains')
  const opened = await store.downloadObject({ ownerId: 'owner-b', objectId: (await store.finishUpload({ ownerId: 'owner-b', uploadId: keeper.uploadId })).objectId })
  assert.equal(opened.sha256, shared.sha256)
})

test('a fresh staged upload still finishes and the TTL option is validated', async (t) => {
  const { store, advance } = await fixture(t)
  const staged = await store.stageUpload({ ownerId: 'owner-a', name: 'a.docx', bytes: DOCX(1) })
  advance(HOUR - 1)
  const done = await store.finishUpload({ ownerId: 'owner-a', uploadId: staged.uploadId })
  advance(10 * HOUR)
  assert.equal((await store.finishUpload({ ownerId: 'owner-a', uploadId: staged.uploadId })).objectId, done.objectId, 'finished uploads never expire')
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-staging-ttl-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await assert.rejects(createLocalObjectStore({ directory, maxObjectBytes: 32, maxOwnerBytes: 64, stagedUploadTtlMs: 0 }), { code: 'UNSAFE_TTL' })
})
