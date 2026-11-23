import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication } from './helpers/prototype-http.mjs'
import { createLocalObjectStore } from '../server/src/storage/local-dev.mjs'
import { DEV_PERSONAL_OWNER, objectStoreDirectory } from '../server/src/modules/objects/routes.mjs'

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])

async function listen(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-object-http-'))
  const server = await createApplication({
    directory,
    userToken: 'personal',
    adminToken: 'admin',
    encryptionKey: 'object-download-test',
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const store = await createLocalObjectStore({
    directory: objectStoreDirectory(directory),
    maxObjectBytes: 64,
    maxOwnerBytes: 128,
  })
  return { directory, server, store, base: `http://127.0.0.1:${server.address().port}` }
}

async function finished(store, ownerId, name, bytes) {
  const staged = await store.stageUpload({ ownerId, name, bytes })
  return store.finishUpload({ ownerId, uploadId: staged.uploadId })
}

test('stored object download is personal, exact, and hidden after trash', async (t) => {
  const { store, base } = await listen(t)
  const owned = await finished(store, DEV_PERSONAL_OWNER, 'notes.docx', ZIP)
  const other = await finished(store, 'other-owner', 'secret.docx', ZIP)
  const path = `/api/v1/objects/${owned.objectId}`
  const personal = { authorization: 'Bearer personal' }

  assert.equal((await fetch(base + path)).status, 401)
  assert.equal((await fetch(base + path, { headers: { authorization: 'Bearer admin' } })).status, 403)

  const missing = await fetch(`${base}/api/v1/objects/00000000-0000-4000-8000-000000000000`, { headers: personal })
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get('content-type'), /json/)
  assert.equal(missing.headers.get('content-disposition'), null)
  assert.equal((await missing.json()).error, '文件不存在')

  const staged = await store.stageUpload({ ownerId: DEV_PERSONAL_OWNER, name: 'draft.docx', bytes: ZIP })
  const unfinished = await fetch(`${base}/api/v1/objects/${staged.uploadId}`, { headers: personal })
  assert.equal(unfinished.status, 404)
  assert.match(unfinished.headers.get('content-type'), /json/)

  const foreign = await fetch(`${base}/api/v1/objects/${other.objectId}`, { headers: personal })
  assert.equal(foreign.status, 404)
  assert.equal((await foreign.json()).error, '文件不存在')

  const downloaded = await fetch(base + path, { headers: personal })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('etag'), null)
  assert.equal(downloaded.headers.get('x-content-sha256'), owned.sha256)
  assert.match(downloaded.headers.get('content-disposition'), /filename\*=UTF-8''notes\.docx/)
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).compare(ZIP), 0)

  await store.trashObject({ ownerId: DEV_PERSONAL_OWNER, objectId: owned.objectId })
  const trashed = await fetch(base + path, { headers: personal })
  assert.equal(trashed.status, 404)
  assert.match(trashed.headers.get('content-type'), /json/)
  assert.equal(trashed.headers.get('content-disposition'), null)

  const posted = await fetch(base + path, { method: 'POST', headers: personal })
  assert.equal(posted.status, 405)
  assert.match(posted.headers.get('content-type'), /json/)
})
