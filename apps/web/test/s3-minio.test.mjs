import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpBlobClient } from '../server/src/storage/s3-http.mjs'
import { createS3ObjectStore } from '../server/src/storage/s3.mjs'

const endpoint = process.env.DYOFFICE_S3_ENDPOINT
const bucket = process.env.DYOFFICE_S3_BUCKET
const accessKeyId = process.env.DYOFFICE_S3_ACCESS_KEY_ID
const secretAccessKey = process.env.DYOFFICE_S3_SECRET_ACCESS_KEY
const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey)
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('MinIO stage, finish, download, trash, restore, purge, and hash', { skip: configured ? false : 'DYOFFICE_S3_ENDPOINT is not set' }, async () => {
  const client = createHttpBlobClient({
    endpoint, bucket, accessKeyId, secretAccessKey,
    region: process.env.DYOFFICE_S3_REGION || 'us-east-1',
  })
  await client.ensureBucket()
  const ownerId = `owner-${randomUUID()}`
  const store = createS3ObjectStore({ client, maxObjectBytes: 1024, maxOwnerBytes: 4096 })
  const staged = await store.stageUpload({ ownerId, name: 'notes.docx', bytes: ZIP, etag: 'client-etag' })
  assert.equal(staged.sha256, sha256(ZIP))
  assert.equal(staged.finished, false)
  const done = await store.finishUpload({ ownerId, uploadId: staged.uploadId })
  assert.deepEqual((await store.downloadObject({ ownerId, objectId: done.objectId })).bytes, ZIP)
  await store.trashObject({ ownerId, objectId: done.objectId })
  await assert.rejects(store.downloadObject({ ownerId, objectId: done.objectId }), { code: 'NOT_FOUND' })
  await store.restoreObject({ ownerId, objectId: done.objectId })
  assert.deepEqual((await store.downloadObject({ ownerId, objectId: done.objectId })).bytes, ZIP)
  await store.trashObject({ ownerId, objectId: done.objectId })
  await store.purgeObject({ ownerId, objectId: done.objectId })
  await assert.rejects(store.downloadObject({ ownerId, objectId: done.objectId }), { code: 'NOT_FOUND' })
  const again = await store.stageUpload({ ownerId, name: 'notes.docx', bytes: ZIP })
  const second = await store.finishUpload({ ownerId, uploadId: again.uploadId })
  await client.put(`blobs/${second.sha256}`, Buffer.from('corrupt-bytes'))
  await assert.rejects(store.downloadObject({ ownerId, objectId: second.objectId }), { code: 'HASH_MISMATCH' })
})
