import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication } from './helpers/prototype-http.mjs'
import { createLocalObjectStore } from '../server/src/storage/local-dev.mjs'
import { DEV_PERSONAL_OWNER, objectStoreDirectory } from '../server/src/modules/objects/routes.mjs'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
const PDF = Buffer.from('%PDF-1.7 sample')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function listen(t, objectQuota) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-object-upload-'))
  const server = await createApplication({
    directory,
    userToken: 'personal',
    adminToken: 'admin',
    encryptionKey: 'object-upload-test',
    objectQuota,
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return {
    directory,
    base: `http://127.0.0.1:${server.address().port}`,
    personal: { authorization: 'Bearer personal' },
  }
}

test('personal upload stages bytes, finishes once, and ignores a client hash', async (t) => {
  const { directory, base, personal } = await listen(t)
  const headers = {
    ...personal,
    'x-file-name': encodeURIComponent('notes.docx'),
    'x-content-sha256': 'client-supplied-hash',
  }
  const staged = await fetch(`${base}/api/v1/objects?ownerId=other-owner`, { method: 'POST', headers, body: ZIP })
  assert.equal(staged.status, 201)
  const upload = await staged.json()
  assert.equal(upload.finished, false)
  assert.equal(upload.sha256, sha256(ZIP))
  assert.equal(upload.size, ZIP.length)
  assert.equal((await fetch(`${base}/api/v1/objects/${upload.uploadId}`, { headers: personal })).status, 404)

  const finished = await fetch(`${base}/api/v1/objects/uploads/${upload.uploadId}/finish`, { method: 'POST', headers: personal })
  assert.equal(finished.status, 200)
  const object = await finished.json()
  const again = await fetch(`${base}/api/v1/objects/uploads/${upload.uploadId}/finish`, { method: 'POST', headers: personal })
  assert.equal(again.status, 200)
  assert.equal((await again.json()).objectId, object.objectId)

  const downloaded = await fetch(`${base}/api/v1/objects/${object.objectId}`, { headers: personal })
  assert.equal(downloaded.status, 200)
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).compare(ZIP), 0)
  const probe = await createLocalObjectStore({
    directory: objectStoreDirectory(directory),
    maxObjectBytes: 64,
    maxOwnerBytes: 128,
  })
  await assert.rejects(probe.downloadObject({ ownerId: 'other-owner', objectId: object.objectId }), { code: 'NOT_FOUND' })
  assert.equal((await probe.downloadObject({ ownerId: DEV_PERSONAL_OWNER, objectId: object.objectId })).sha256, sha256(ZIP))

  assert.equal((await fetch(`${base}/api/v1/objects`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent('notes.docx') }, body: ZIP })).status, 401)
  assert.equal((await fetch(`${base}/api/v1/objects`, { method: 'POST', headers: { ...headers, authorization: 'Bearer admin' }, body: ZIP })).status, 403)
  const foreign = await probe.stageUpload({ ownerId: 'other-owner', name: 'secret.docx', bytes: ZIP })
  assert.equal((await fetch(`${base}/api/v1/objects/uploads/${foreign.uploadId}/finish`, { method: 'POST', headers: personal })).status, 404)

  for (const [name, bytes] of [['', ZIP], ['../notes.docx', ZIP], ['notes.docx', Buffer.from('not-a-zip')], ['notes.docx', Buffer.alloc(0)]]) {
    const rejected = await fetch(`${base}/api/v1/objects`, {
      method: 'POST',
      headers: { ...personal, 'x-file-name': encodeURIComponent(name) },
      body: bytes,
    })
    assert.equal(rejected.status, 400, name || 'empty-name')
    assert.match(rejected.headers.get('content-type'), /json/)
    assert.equal(rejected.headers.get('content-disposition'), null)
  }

  const legacy = await fetch(`${base}/api/files`, {
    method: 'POST',
    headers: { ...personal, 'x-file-name': 'legacy.pdf' },
    body: PDF,
  })
  assert.equal(legacy.status, 201)
})

test('a second personal upload cannot pass the owner quota', async (t) => {
  const bytes = Buffer.concat([ZIP, Buffer.alloc(40)])
  const { base, personal } = await listen(t, { maxObjectBytes: bytes.length, maxOwnerBytes: bytes.length })
  const headers = { ...personal, 'x-file-name': encodeURIComponent('one.docx') }
  assert.equal((await fetch(`${base}/api/v1/objects`, { method: 'POST', headers, body: bytes })).status, 201)
  const second = await fetch(`${base}/api/v1/objects`, {
    method: 'POST',
    headers: { ...personal, 'x-file-name': encodeURIComponent('two.docx') },
    body: bytes,
  })
  assert.equal(second.status, 413)
  assert.match((await second.json()).error, /配额/)
})
