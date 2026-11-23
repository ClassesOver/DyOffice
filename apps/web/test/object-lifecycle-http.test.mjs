import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication } from './helpers/prototype-http.mjs'
import { objectStoreDirectory } from '../server/src/modules/objects/routes.mjs'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])

async function listen(t, objectQuota) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-object-life-'))
  const server = await createApplication({
    directory,
    userToken: 'personal',
    adminToken: 'admin',
    encryptionKey: 'object-lifecycle-test',
    objectQuota,
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, base: `http://127.0.0.1:${server.address().port}`, personal: { authorization: 'Bearer personal' } }
}

async function upload(base, headers, bytes, name) {
  const staged = await fetch(`${base}/api/v1/objects`, {
    method: 'POST',
    headers: { ...headers, 'x-file-name': encodeURIComponent(name) },
    body: bytes,
  })
  assert.equal(staged.status, 201)
  const uploadBody = await staged.json()
  const finished = await fetch(`${base}/api/v1/objects/uploads/${uploadBody.uploadId}/finish`, { method: 'POST', headers })
  assert.equal(finished.status, 200)
  return finished.json()
}

test('trash hides download, restore returns the bytes, and purge frees quota', async (t) => {
  const bytes = Buffer.concat([ZIP, Buffer.alloc(24)])
  const { base, personal } = await listen(t, { maxObjectBytes: bytes.length, maxOwnerBytes: bytes.length })
  const object = await upload(base, personal, bytes, 'notes.docx')
  const path = `${base}/api/v1/objects/${object.objectId}`

  assert.equal((await fetch(`${path}/trash`, { method: 'POST', headers: { authorization: 'Bearer admin' } })).status, 403)
  const trashed = await fetch(`${path}/trash`, { method: 'POST', headers: personal })
  assert.equal(trashed.status, 200)
  assert.equal((await trashed.json()).state, 'trash')
  const hidden = await fetch(path, { headers: personal })
  assert.equal(hidden.status, 404)
  assert.match(hidden.headers.get('content-type'), /json/)
  assert.equal(hidden.headers.get('content-disposition'), null)

  const blocked = await fetch(`${base}/api/v1/objects`, {
    method: 'POST',
    headers: { ...personal, 'x-file-name': encodeURIComponent('other.docx') },
    body: bytes,
  })
  assert.equal(blocked.status, 413)

  const restored = await fetch(`${path}/restore`, { method: 'POST', headers: personal })
  assert.equal(restored.status, 200)
  assert.equal((await restored.json()).state, 'active')
  const again = await fetch(path, { headers: personal })
  assert.equal(again.status, 200)
  assert.equal(Buffer.from(await again.arrayBuffer()).compare(bytes), 0)

  await fetch(`${path}/trash`, { method: 'POST', headers: personal })
  const purged = await fetch(`${path}/purge`, { method: 'POST', headers: personal })
  assert.equal(purged.status, 200)
  assert.equal((await purged.json()).state, 'purged')
  assert.equal((await fetch(path, { headers: personal })).status, 404)
  const replacement = await upload(base, personal, bytes, 'other.docx')
  assert.equal(replacement.sha256, object.sha256)
})

test('a stored object whose bytes no longer match its hash is not downloaded', async (t) => {
  const { directory, base, personal } = await listen(t)
  const object = await upload(base, personal, ZIP, 'notes.docx')
  await writeFile(join(objectStoreDirectory(directory), 'blobs', object.sha256), Buffer.from('corrupt-bytes'))
  const response = await fetch(`${base}/api/v1/objects/${object.objectId}`, { headers: personal })
  assert.equal(response.status, 500)
  assert.match(response.headers.get('content-type'), /json/)
  assert.equal(response.headers.get('content-disposition'), null)
  assert.equal((await response.json()).error, '服务暂时不可用')
})
