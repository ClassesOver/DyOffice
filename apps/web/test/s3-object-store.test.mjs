import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeBlobClient } from '../server/src/storage/fake-blob-client.mjs'
import { createS3ObjectStore } from '../server/src/storage/s3.mjs'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const WIDE = Buffer.concat([ZIP, Buffer.alloc(40)])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function store(limits = { maxObjectBytes: 64, maxOwnerBytes: 128 }, hooks = {}) {
  const client = createFakeBlobClient()
  return { client, store: createS3ObjectStore({ client, ...limits, ...hooks }) }
}

async function finished(objectStore, ownerId, name, bytes) {
  const staged = await objectStore.stageUpload({ ownerId, name, bytes, etag: 'client-etag' })
  return { staged, done: await objectStore.finishUpload({ ownerId, uploadId: staged.uploadId }) }
}

test('the adapter hashes bytes and ignores the client ETag', async () => {
  const { client, store: objectStore } = store()
  const { staged, done } = await finished(objectStore, 'owner-a', 'notes.docx', ZIP)
  assert.equal(staged.sha256, sha256(ZIP))
  assert.notEqual(staged.sha256, 'client-etag')
  const downloaded = await objectStore.downloadObject({ ownerId: 'owner-a', objectId: done.objectId })
  assert.equal(downloaded.sha256, sha256(ZIP))
  assert.deepEqual(downloaded.bytes, ZIP)
  const blob = (await client.list('blobs/'))[0]
  const etag = (await client.put(blob, ZIP, { immutable: true })).etag
  assert.match(etag, /^W\/"not-sha-/)
  assert.notEqual(etag, sha256(ZIP))
  client.replaceForTest(blob, Buffer.from('corrupt-bytes'))
  await assert.rejects(objectStore.downloadObject({ ownerId: 'owner-a', objectId: done.objectId }), { code: 'HASH_MISMATCH' })
})

test('a failure before the blob is published leaves no object', async () => {
  const { client, store: objectStore } = store({ maxObjectBytes: 64, maxOwnerBytes: 128 }, {
    afterBytesWritten: () => { throw new Error('interrupted') },
  })
  await assert.rejects(objectStore.stageUpload({ ownerId: 'owner-a', name: 'notes.docx', bytes: ZIP }), /interrupted/)
  assert.deepEqual(await client.list(''), [])
})

test('quota, trash, and the last shared blob follow the local store rules', async () => {
  const { client, store: objectStore } = store({ maxObjectBytes: WIDE.length, maxOwnerBytes: WIDE.length })
  const first = await finished(objectStore, 'owner-a', 'one.docx', WIDE)
  await assert.rejects(objectStore.stageUpload({ ownerId: 'owner-a', name: 'two.docx', bytes: WIDE }), { code: 'QUOTA' })
  await objectStore.trashObject({ ownerId: 'owner-a', objectId: first.done.objectId })
  await assert.rejects(objectStore.downloadObject({ ownerId: 'owner-a', objectId: first.done.objectId }), { code: 'NOT_FOUND' })
  await assert.rejects(objectStore.stageUpload({ ownerId: 'owner-a', name: 'two.docx', bytes: WIDE }), { code: 'QUOTA' })

  const shared = store()
  const left = await finished(shared.store, 'owner-a', 'same.docx', ZIP)
  const right = await finished(shared.store, 'owner-b', 'same.docx', ZIP)
  await assert.rejects(shared.store.downloadObject({ ownerId: 'owner-b', objectId: left.done.objectId }), { code: 'NOT_FOUND' })
  await shared.store.trashObject({ ownerId: 'owner-a', objectId: left.done.objectId })
  await shared.store.purgeObject({ ownerId: 'owner-a', objectId: left.done.objectId })
  assert.deepEqual((await shared.store.downloadObject({ ownerId: 'owner-b', objectId: right.done.objectId })).bytes, ZIP)
  assert.equal((await shared.client.list('blobs/')).length, 1)
  await shared.store.trashObject({ ownerId: 'owner-b', objectId: right.done.objectId })
  await shared.store.purgeObject({ ownerId: 'owner-b', objectId: right.done.objectId })
  assert.deepEqual(await shared.client.list('blobs/'), [])
})
