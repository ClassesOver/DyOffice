import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalObjectStore } from '../server/src/storage/local-dev.mjs'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const BIG = Buffer.concat([ZIP, Buffer.alloc(56)])

async function storeIn(t, limits) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-recycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await createLocalObjectStore({ directory, ...limits })
  return { directory, store }
}

async function finished(store, ownerId, name, bytes) {
  const staged = await store.stageUpload({ ownerId, name, bytes })
  return store.finishUpload({ ownerId, uploadId: staged.uploadId })
}

test('download is owner-scoped and stops while the object is in the recycle bin', async (t) => {
  const { store } = await storeIn(t, { maxObjectBytes: 64, maxOwnerBytes: 96 })
  const object = await finished(store, 'owner-a', 'notes.docx', ZIP)
  const downloaded = await store.downloadObject({ ownerId: 'owner-a', objectId: object.objectId })
  assert.deepEqual(downloaded.bytes, ZIP)
  await assert.rejects(store.downloadObject({ ownerId: 'owner-b', objectId: object.objectId }), { code: 'NOT_FOUND' })
  await assert.rejects(store.trashObject({ ownerId: 'owner-b', objectId: object.objectId }), { code: 'NOT_FOUND' })
  await store.trashObject({ ownerId: 'owner-a', objectId: object.objectId })
  await assert.rejects(store.downloadObject({ ownerId: 'owner-a', objectId: object.objectId }), { code: 'NOT_FOUND' })
  await assert.rejects(store.restoreObject({ ownerId: 'owner-b', objectId: object.objectId }), { code: 'NOT_FOUND' })
  await store.restoreObject({ ownerId: 'owner-a', objectId: object.objectId })
  assert.deepEqual((await store.downloadObject({ ownerId: 'owner-a', objectId: object.objectId })).bytes, ZIP)
  await store.trashObject({ ownerId: 'owner-a', objectId: object.objectId })
  await store.purgeObject({ ownerId: 'owner-a', objectId: object.objectId })
  await assert.rejects(store.downloadObject({ ownerId: 'owner-a', objectId: object.objectId }), { code: 'NOT_FOUND' })
  await assert.rejects(store.purgeObject({ ownerId: 'owner-a', objectId: object.objectId }), { code: 'NOT_FOUND' })
})

test('trashing does not free quota and a shared blob survives the other owner', async (t) => {
  const { directory, store } = await storeIn(t, { maxObjectBytes: 64, maxOwnerBytes: 64 })
  const first = await finished(store, 'owner-a', 'a.docx', BIG)
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'b.docx', bytes: BIG }), { code: 'QUOTA' })
  await store.trashObject({ ownerId: 'owner-a', objectId: first.objectId })
  await assert.rejects(store.stageUpload({ ownerId: 'owner-a', name: 'b.docx', bytes: BIG }), { code: 'QUOTA' })
  await store.purgeObject({ ownerId: 'owner-a', objectId: first.objectId })
  const second = await store.stageUpload({ ownerId: 'owner-a', name: 'b.docx', bytes: BIG })
  assert.equal(second.finished, false)

  const shared = await storeIn(t, { maxObjectBytes: 64, maxOwnerBytes: 96 })
  const left = await finished(shared.store, 'owner-a', 'same.docx', ZIP)
  const right = await finished(shared.store, 'owner-b', 'same.docx', ZIP)
  await shared.store.trashObject({ ownerId: 'owner-a', objectId: left.objectId })
  await shared.store.purgeObject({ ownerId: 'owner-a', objectId: left.objectId })
  assert.deepEqual((await shared.store.downloadObject({ ownerId: 'owner-b', objectId: right.objectId })).bytes, ZIP)
  assert.equal((await readdir(join(shared.directory, 'blobs'))).includes(left.sha256), true)
  await shared.store.trashObject({ ownerId: 'owner-b', objectId: right.objectId })
  await shared.store.purgeObject({ ownerId: 'owner-b', objectId: right.objectId })
  assert.equal((await readdir(join(shared.directory, 'blobs'))).includes(left.sha256), false)
})

test('purging the last copy cannot delete a concurrent upload of the same bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-recycle-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let objectId
  let armed = false
  const store = await createLocalObjectStore({
    directory,
    maxObjectBytes: 64,
    maxOwnerBytes: 96,
    afterReferencePublished: async () => {
      if (!armed) return
      await store.trashObject({ ownerId: 'owner-a', objectId })
      await store.purgeObject({ ownerId: 'owner-a', objectId })
    },
  })
  const existing = await finished(store, 'owner-a', 'same.docx', ZIP)
  objectId = existing.objectId
  armed = true
  const staged = await store.stageUpload({ ownerId: 'owner-b', name: 'same.docx', bytes: ZIP })
  const completed = await store.finishUpload({ ownerId: 'owner-b', uploadId: staged.uploadId })
  const downloaded = await store.downloadObject({ ownerId: 'owner-b', objectId: completed.objectId })
  assert.deepEqual(downloaded.bytes, ZIP)
})

test('an unfinished upload cannot be downloaded or trashed', async (t) => {
  const { store } = await storeIn(t, { maxObjectBytes: 64, maxOwnerBytes: 96 })
  const staged = await store.stageUpload({ ownerId: 'owner-a', name: 'notes.docx', bytes: ZIP })
  await assert.rejects(store.downloadObject({ ownerId: 'owner-a', objectId: staged.uploadId }), { code: 'NOT_FOUND' })
  await assert.rejects(store.trashObject({ ownerId: 'owner-a', objectId: staged.uploadId }), { code: 'NOT_FOUND' })
})
