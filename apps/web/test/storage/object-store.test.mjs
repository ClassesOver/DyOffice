import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { s3Fixture } from '../helpers/s3.mjs'

const key = () => `${randomUUID()}/${randomUUID()}/objects/${randomUUID()}`
const hello = Buffer.from('hello'), hash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
async function fixture(t, kind) {
  if (kind === 'local') {
    const directory = await mkdtemp(join(tmpdir(), 'dyoffice-objects-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const { createLocalObjectStore } = await import('../../server/src/storage/local-dev.ts')
    const store = await createLocalObjectStore({ directory })
    return { store, directory, corrupt: async (objectKey, bytes) => {
      const files = await readdir(directory)
      assert.equal(files.length, 1)
      await writeFile(join(directory, files[0]), bytes)
    } }
  }
  return s3Fixture(t)
}
for (const kind of ['local','s3']) {
  test(`${kind} immutable put computes SHA-256 and refuses overwrites including equal bytes`, async t => {
    const { store } = await fixture(t, kind)
    const objectKey = key(), ref = await store.putImmutable(objectKey, hello)
    assert.deepEqual(ref, { key: objectKey, size: 5, sha256: hash })
    assert.deepEqual(await store.readVerified(ref), hello)
    await assert.rejects(() => store.putImmutable(objectKey, hello), { statusCode: 409 })
    await assert.rejects(() => store.putImmutable(objectKey, Buffer.from('changed')), { statusCode: 409 })
    assert.deepEqual(await store.readVerified(ref), hello)
  })
  test(`${kind} concurrent publication permits one winner without partial contents`, async t => {
    const { store } = await fixture(t, kind)
    const objectKey = key(), a = Buffer.alloc(100_000, 65), b = Buffer.alloc(100_000, 66)
    const results = await Promise.allSettled([store.putImmutable(objectKey, a), store.putImmutable(objectKey, b)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const winner = results.find(result => result.status === 'fulfilled').value
    const actual = await store.readVerified(winner)
    assert.ok(actual.equals(a) || actual.equals(b))
    assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409)
  })
  test(`${kind} verified reads reject corruption, incorrect size/hash and missing objects`, async t => {
    const { store, corrupt } = await fixture(t, kind)
    const ref = await store.putImmutable(key(), hello)
    await assert.rejects(() => store.readVerified({ ...ref, size: 4 }))
    await assert.rejects(() => store.readVerified({ ...ref, sha256: '0'.repeat(64) }))
    await corrupt(ref.key, Buffer.from('jello')) // Same length, so length checks alone cannot detect corruption.
    await assert.rejects(() => store.readVerified(ref), { statusCode: 503 })
    await assert.rejects(() => store.readVerified({ ...ref, key: key() }), { statusCode: 503 })
  })
  test(`${kind} object names and sizes cannot escape the trusted namespace or allocation bound`, async t => {
    const { store } = await fixture(t, kind)
    for (const unsafe of ['../outside','/etc/passwd',key() + '/../outside','objects/' + randomUUID(),key().replace('/objects/', '/%2e%2e/')]) {
      await assert.rejects(() => store.putImmutable(unsafe, hello), { statusCode: 400 })
    }
    await assert.rejects(() => store.putImmutable(key(), Buffer.alloc(0)), { statusCode: 400 })
    await assert.rejects(() => store.readVerified({ key: key(), size: 2 ** 40, sha256: hash }), { statusCode: 400 })
  })
}

test('local object store refuses symlink roots and symlink replacements of published objects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-symlinks-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { createLocalObjectStore } = await import('../../server/src/storage/local-dev.ts')
  await symlink(directory, join(directory, 'root-link'))
  await assert.rejects(() => createLocalObjectStore({ directory: join(directory, 'root-link') }))
  const store = await createLocalObjectStore({ directory: join(directory, 'store') })
  const ref = await store.putImmutable(key(), hello)
  const [filename] = await readdir(join(directory, 'store'))
  await rm(join(directory, 'store', filename))
  await writeFile(join(directory, 'secret'), hello)
  await symlink(join(directory, 'secret'), join(directory, 'store', filename))
  await assert.rejects(() => store.readVerified(ref), { statusCode: 503 })
})

for (const kind of ['local','s3']) test(`${kind} publication snapshots caller bytes before asynchronous I/O`, async t => {
  const { store } = await fixture(t, kind), input = Buffer.from('hello')
  const pending = store.putImmutable(key(), input)
  input.fill(0)
  const reference = await pending
  assert.deepEqual(await store.readVerified(reference), hello)
})

test('ordinary File API configuration retains local-dev storage for one service account', async t => {
  const { configuredObjectStore } = await import('../../server/src/storage/config.ts')
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-local-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const storage = await configuredObjectStore({ DYOFFICE_FILE_API: 'experimental', DYOFFICE_OBJECT_STORE: 'local-dev', DYOFFICE_OBJECT_DIRECTORY: directory })
  t.after(() => storage.close())
  const reference = await storage.objectStore.putImmutable(key(), hello)
  assert.deepEqual(await storage.objectStore.readVerified(reference), hello)
})

test('file storage configuration requires explicit experimental backend and refuses unsafe endpoints', async () => {
  const { configuredObjectStore } = await import('../../server/src/storage/config.ts')
  assert.equal((await configuredObjectStore({})).objectStore,undefined)
  for (const environment of [
    { DYOFFICE_OBJECT_STORE: 'local-dev' },
    { DYOFFICE_FILE_API: 'production', DYOFFICE_OBJECT_STORE: 'local-dev' },
    { DYOFFICE_FILE_API: 'experimental', DYOFFICE_OBJECT_STORE: 'local-dev' },
    { DYOFFICE_FILE_API: 'experimental', DYOFFICE_OBJECT_STORE: 'unknown' },
    { DYOFFICE_FILE_API: 'experimental', DYOFFICE_OBJECT_STORE: 'local-dev', DYOFFICE_FILE_QUOTA_BYTES: '-1' },
  ]) await assert.rejects(() => configuredObjectStore(environment))
  for (const endpoint of ['http://storage.example','https://user:secret@storage.example','https://storage.example?token=secret']) {
    await assert.rejects(() => configuredObjectStore({ DYOFFICE_FILE_API: 'experimental', DYOFFICE_OBJECT_STORE: 's3', DYOFFICE_S3_REGION: 'us-east-1', DYOFFICE_S3_BUCKET: 'private-test', DYOFFICE_S3_ENDPOINT: endpoint }))
  }
})
