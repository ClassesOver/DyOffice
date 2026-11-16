import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalObjectStore } from '../../server/src/storage/local-dev.ts'
import * as object from '../../server/src/storage/object-store.ts'
const key = () => `${randomUUID()}/${randomUUID()}/objects/${randomUUID()}`

test('verification-only stream validates full contents without returning payload', async () => {
  assert.equal(typeof object.verifyStream, 'function')
  const bytes = Buffer.alloc(1024 * 1024, 7), ref = object.objectReference(key(), bytes)
  async function* chunks() { for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536) }
  assert.equal(await object.verifyStream(chunks(), ref), undefined)
  for (const bad of [{ ...ref, size: ref.size - 1 }, { ...ref, size: ref.size + 1 }, { ...ref, sha256: '0'.repeat(64) }]) {
    await assert.rejects(() => object.verifyStream(chunks(), bad), { statusCode: 503 })
  }
  let closed = false
  async function* oversized() { try { yield bytes; yield bytes } finally { closed = true } }
  await assert.rejects(() => object.verifyStream(oversized(), ref), { statusCode: 503 })
  assert.equal(closed, true)
  async function* broken() { yield bytes.subarray(0, 4); throw new Error('source failed') }
  await assert.rejects(() => object.verifyStream(broken(), ref), /source failed/)
})

test('local verification-only adapter verifies bytes and rejects same-size corruption', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-only-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await createLocalObjectStore({ directory })
  assert.equal(typeof store.verifyObject, 'function')
  const ref = await store.putImmutable(key(), Buffer.from('hello'))
  assert.equal(await store.verifyObject(ref), undefined)
  assert.equal((await store.readVerified(ref)).toString(), 'hello')
  await writeFile(join(directory, ref.key.replaceAll('/', '_')), 'jello')
  await assert.rejects(() => store.verifyObject(ref), { statusCode: 503 })
  await assert.rejects(() => store.verifyObject({ ...ref, key: key() }), { statusCode: 503 })
})

test('S3 verification destroys malformed or failed response streams', async () => {
  const { Readable } = await import('node:stream')
  const { createS3ObjectStore } = await import('../../server/src/storage/s3.ts')
  const bytes = Buffer.from('hello'), ref = object.objectReference(key(), bytes)
  const cases = [
    { name: 'valid', body: () => Readable.from([bytes]), length: 5, valid: true },
    { name: 'wrong header', body: () => Readable.from([bytes]), length: 4 },
    { name: 'oversized', body: () => Readable.from([bytes, bytes]), length: 5 },
    { name: 'truncated', body: () => Readable.from([bytes.subarray(0, 3)]), length: 5 },
    { name: 'stream error', body: () => Readable.from((async function* () { yield bytes.subarray(0, 3); throw new Error('read failed') })()), length: 5 },
    { name: 'premature close', body: () => new Readable({ read() { this.push(bytes.subarray(0, 3)); this.destroy() } }), length: 5 },
  ]
  for (const entry of cases) {
    const body = entry.body()
    // Transport fixture returns real Node streams; production hashing/cleanup runs unchanged.
    const store = createS3ObjectStore({ bucket: 'verify-test', client: { async send() { return { Body: body, ContentLength: entry.length } } } })
    if (entry.valid) assert.equal(await store.verifyObject(ref), undefined)
    else await assert.rejects(() => store.verifyObject(ref), { statusCode: 503 }, entry.name)
    assert.equal(body.destroyed, true, entry.name)
  }
})
