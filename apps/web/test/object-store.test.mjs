import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const PDF = Buffer.from('%PDF-1.7\n% sample\n')

async function loadStore() {
  try {
    return await import('../server/src/storage/local-dev.mjs')
  } catch (error) {
    assert.fail(`T05 local object store is not implemented (${error.code ?? error.name}: ${error.message})`)
  }
}

async function fixture(t) {
  const { createLocalObjectStore } = await loadStore()
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-objects-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await createLocalObjectStore({ directory, maxObjectBytes: 64, maxOwnerBytes: 96 })
  return { directory, store }
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('office objects accept the four formats and reject empty, fake, oversized, and unsafe names', async (t) => {
  const { store } = await fixture(t)
  for (const name of ['notes.docx', 'book.xlsx', 'deck.pptx']) {
    const staged = await store.stageUpload({ ownerId: 'owner-a', name, bytes: ZIP })
    assert.equal(staged.sha256, sha(ZIP))
    assert.equal(staged.finished, false)
  }
  const pdf = await store.stageUpload({ ownerId: 'owner-a', name: 'scan.pdf', bytes: PDF })
  assert.equal(pdf.format, 'pdf')
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'empty.docx', bytes: Buffer.alloc(0) }), { code: 'EMPTY' })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'fake.docx', bytes: Buffer.from('PK not a zip') }), { code: 'MAGIC_MISMATCH' })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'wrong.pdf', bytes: ZIP }), { code: 'MAGIC_MISMATCH' })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'notes.html', bytes: ZIP }), { code: 'UNSUPPORTED_TYPE' })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: '../secret.docx', bytes: ZIP }), { code: 'UNSAFE_NAME' })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'a/b.docx', bytes: ZIP }), { code: 'UNSAFE_NAME' })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'big.docx', bytes: Buffer.concat([ZIP, Buffer.alloc(128)]) }), { code: 'OVERSIZE' })
})

test('staged uploads are owner-scoped, unfinished bytes are not readable, and the digest ignores ETag', async (t) => {
  const { store, directory } = await fixture(t)
  const staged = await store.stageUpload({
    ownerId: 'owner-a',
    name: 'notes.docx',
    bytes: ZIP,
    etag: 'client-etag-is-not-the-digest',
  })
  assert.equal(staged.sha256, sha(ZIP))
  assert.notEqual(staged.sha256, 'client-etag-is-not-the-digest')
  await assert.rejects(store.openObject({ ownerId: 'owner-a', objectId: staged.uploadId }), { code: 'NOT_FOUND' })
  await assert.rejects(store.finishUpload({ ownerId: 'owner-b', uploadId: staged.uploadId }), { code: 'NOT_FOUND' })
  const finished = await store.finishUpload({ ownerId: 'owner-a', uploadId: staged.uploadId })
  assert.equal(finished.sha256, sha(ZIP))
  const opened = await store.openObject({ ownerId: 'owner-a', objectId: finished.objectId })
  assert.deepEqual(opened.bytes, ZIP)
  await assert.rejects(store.openObject({ ownerId: 'owner-b', objectId: finished.objectId }), { code: 'NOT_FOUND' })
  const again = await store.finishUpload({ ownerId: 'owner-a', uploadId: staged.uploadId })
  assert.equal(again.objectId, finished.objectId)
  const names = await readdir(directory, { recursive: true })
  assert.equal(names.some((name) => String(name).includes('..')), false)
})

test('concurrent uploads for one owner cannot pass the quota together', async (t) => {
  const { createLocalObjectStore } = await loadStore()
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-objects-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const payload = Buffer.concat([ZIP, Buffer.alloc(56)])
  const store = await createLocalObjectStore({ directory, maxObjectBytes: 64, maxOwnerBytes: 96 })
  const results = await Promise.allSettled([
    store.stageUpload({ ownerId: 'owner-a', name: 'a.docx', bytes: payload }),
    store.stageUpload({ ownerId: 'owner-a', name: 'b.docx', bytes: payload }),
  ])
  const accepted = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(accepted.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'QUOTA')
})

test('overlapping finish calls publish one object', async (t) => {
  const { store, directory } = await fixture(t)
  const staged = await store.stageUpload({ ownerId: 'owner-a', name: 'notes.docx', bytes: ZIP })
  const [first, second] = await Promise.all([
    store.finishUpload({ ownerId: 'owner-a', uploadId: staged.uploadId }),
    store.finishUpload({ ownerId: 'owner-a', uploadId: staged.uploadId }),
  ])
  assert.equal(first.objectId, second.objectId)
  const records = (await readdir(join(directory, 'objects', 'owner-a'))).filter((name) => name.endsWith('.json'))
  assert.deepEqual(records, [`${first.objectId}.json`])
  const replay = await store.finishUpload({ ownerId: 'owner-a', uploadId: staged.uploadId })
  assert.equal(replay.objectId, first.objectId)
})

test('a failure after the bytes are written does not publish a completed object', async (t) => {
  const { createLocalObjectStore } = await loadStore()
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-objects-abort-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await createLocalObjectStore({
    directory,
    maxObjectBytes: 64,
    maxOwnerBytes: 96,
    afterBytesWritten: () => {
      throw Object.assign(new Error('disk interrupted'), { code: 'INTERRUPTED' })
    },
  })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'notes.docx', bytes: ZIP }), { code: 'INTERRUPTED' })
  const names = await readdir(directory, { recursive: true })
  assert.equal(names.some((name) => String(name).endsWith('.json')), false)
  await assert.rejects(store.openObject({ ownerId: 'owner-a', objectId: 'missing' }), { code: 'NOT_FOUND' })
})
