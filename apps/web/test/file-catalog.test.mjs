import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFileCatalog } from '../server/src/storage/file-catalog.mjs'
import { createFakeBlobClient } from '../server/src/storage/fake-blob-client.mjs'
import { createS3ObjectStore } from '../server/src/storage/s3.mjs'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const DEPLOYMENT = '11111111-1111-4111-8111-111111111111'
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function memoryDb() {
  const rows = []
  let failInsert = false
  return {
    rows,
    failNextInsert() { failInsert = true },
    async query(sql, params) {
      if (sql.startsWith('INSERT')) {
        if (failInsert) {
          failInsert = false
          throw new Error('insert failed')
        }
        rows.push({
          id: params[0], deploymentId: params[1], ownerUserId: params[2], objectKey: params[3],
          sha256: params[4], sizeBytes: params[5], format: params[6], name: params[7], state: 'active',
        })
        return { rows: [], rowCount: 1 }
      }
      if (sql.startsWith('SELECT')) {
        const [deploymentId, ownerUserId, id] = params
        const row = rows.find((entry) => entry.deploymentId === deploymentId && entry.ownerUserId === ownerUserId && entry.id === id && entry.state === 'active')
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.startsWith('UPDATE')) {
        const [deploymentId, ownerUserId, id] = params
        const row = rows.find((entry) => entry.deploymentId === deploymentId && entry.ownerUserId === ownerUserId && entry.id === id && entry.state === 'active')
        if (!row) return { rows: [], rowCount: 0 }
        row.state = 'trash'
        return { rows: [], rowCount: 1 }
      }
      throw new Error('unexpected sql')
    },
  }
}

function catalog() {
  const db = memoryDb()
  const client = createFakeBlobClient()
  const objectStore = createS3ObjectStore({ client, maxObjectBytes: 64, maxOwnerBytes: 128 })
  return { db, client, objectStore, files: createFileCatalog({ db, objectStore }) }
}

test('a file row is readable only by its owner and only while active', async () => {
  const { files } = catalog()
  assert.equal(files.scope.enforcement, 'pending-t04')
  const saved = await files.saveNewFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_A, name: 'notes.docx', bytes: ZIP })
  const downloaded = await files.downloadFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_A, fileId: saved.fileId })
  assert.deepEqual(downloaded.bytes, ZIP)
  assert.equal(downloaded.sha256, saved.sha256)
  await assert.rejects(files.downloadFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_B, fileId: saved.fileId }), { code: 'NOT_FOUND' })
  await files.trashFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_A, fileId: saved.fileId })
  await assert.rejects(files.downloadFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_A, fileId: saved.fileId }), { code: 'NOT_FOUND' })
})

test('a database failure after the object is stored does not publish a file row', async () => {
  const { db, client, files } = catalog()
  db.failNextInsert()
  await assert.rejects(
    files.saveNewFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_A, name: 'notes.docx', bytes: ZIP }),
    { code: 'METADATA_FAILED' },
  )
  assert.equal(db.rows.length, 0)
  assert.equal((await client.list('objects/')).length, 1)
  assert.equal((await client.list('blobs/')).length, 1)
})

test('a row whose blob was removed does not download', async () => {
  const { client, files } = catalog()
  const saved = await files.saveNewFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_A, name: 'notes.docx', bytes: ZIP })
  client.replaceForTest(`blobs/${saved.sha256}`, Buffer.from('different'))
  await assert.rejects(files.downloadFile({ deploymentId: DEPLOYMENT, ownerId: OWNER_A, fileId: saved.fileId }), { code: 'HASH_MISMATCH' })
})
