import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertOwnerId, validateOfficeObject } from './validation.mjs'

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status })
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, path)
}

function createExclusive() {
  const tails = new Map()
  return function exclusive(key, fn) {
    const previous = tails.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    tails.set(key, gate)
    return previous.then(() => {}, () => {}).then(fn).finally(() => release())
  }
}

/**
 * Single-directory content-addressed store for development.
 * It is not the enterprise S3 adapter and it does not enforce database RLS.
 * Callers must pass the owner id established by the server.
 */
export async function createLocalObjectStore({ directory, maxObjectBytes, maxOwnerBytes, afterBytesWritten, afterReferencePublished } = {}) {
  if (!directory || typeof directory !== 'string') reject('UNSAFE_DIRECTORY')
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) reject('UNSAFE_QUOTA')
  if (!Number.isSafeInteger(maxOwnerBytes) || maxOwnerBytes < maxObjectBytes) reject('UNSAFE_QUOTA')
  const root = directory
  const blobs = join(root, 'blobs')
  const staging = join(root, 'staging')
  const objects = join(root, 'objects')
  const temporary = join(root, 'tmp')
  await mkdir(blobs, { recursive: true, mode: 0o700 })
  await mkdir(staging, { recursive: true, mode: 0o700 })
  await mkdir(objects, { recursive: true, mode: 0o700 })
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  const exclusive = createExclusive()
  const exclusiveSha = createExclusive()

  async function installBlob(scratch, sha256) {
    const blob = join(blobs, sha256)
    try {
      await rename(scratch, blob)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await rm(scratch, { force: true })
    }
  }

  function objectPath(ownerId, objectId) {
    return join(objects, ownerId, `${objectId}.json`)
  }

  async function recordsUnder(base, include) {
    const found = []
    let owners = []
    try { owners = await readdir(base) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const ownerId of owners) {
      let names = []
      try { names = await readdir(join(base, ownerId)) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const record = await readJson(join(base, ownerId, name))
        if (record && include(record)) found.push(record)
      }
    }
    return found
  }

  async function blobStillNeeded(sha256) {
    const staged = await recordsUnder(staging, (record) => record.sha256 === sha256 && record.finished !== true)
    if (staged.length > 0) return true
    const kept = await recordsUnder(objects, (record) => record.sha256 === sha256)
    return kept.length > 0
  }

  async function ownerBytes(ownerId) {
    let total = 0
    for (const base of [join(staging, ownerId), join(objects, ownerId)]) {
      let names = []
      try { names = await readdir(base) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const record = await readJson(join(base, name))
        if (!record || !Number.isSafeInteger(record.size)) continue
        if (record.finished && base.startsWith(staging)) continue
        total += record.size
      }
    }
    return total
  }

  return {
    async stageUpload({ ownerId, name, bytes }) {
      assertOwnerId(ownerId)
      const { format } = validateOfficeObject({ name, bytes, maxBytes: maxObjectBytes })
      return exclusive(ownerId, async () => {
        const used = await ownerBytes(ownerId)
        if (used + bytes.length > maxOwnerBytes) reject('QUOTA')
        const uploadId = randomUUID()
        const sha256 = digest(bytes)
        const scratch = join(temporary, `${uploadId}.bin`)
        const recordPath = join(staging, ownerId, `${uploadId}.json`)
        await writeFile(scratch, bytes, { mode: 0o600 })
        let published = false
        try {
          if (afterBytesWritten) await afterBytesWritten()
          await mkdir(join(staging, ownerId), { recursive: true, mode: 0o700 })
          await writeJson(recordPath, {
            uploadId, ownerId, name, format, size: bytes.length, sha256, finished: false,
          })
          published = true
          if (afterReferencePublished) await afterReferencePublished()
          // The staging record is visible before the shared blob is installed.
          // A purge of another owner's last copy then sees this reference.
          await exclusiveSha(sha256, () => installBlob(scratch, sha256))
        } catch (error) {
          await rm(scratch, { force: true })
          if (published) await rm(recordPath, { force: true })
          throw error
        }
        return { uploadId, sha256, size: bytes.length, format, finished: false }
      })
    },

    async finishUpload({ ownerId, uploadId }) {
      assertOwnerId(ownerId)
      if (typeof uploadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(uploadId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const recordPath = join(staging, ownerId, `${uploadId}.json`)
        const record = await readJson(recordPath)
        if (!record || record.ownerId !== ownerId) reject('NOT_FOUND', 404)
        const objectId = record.objectId ?? randomUUID()
        if (record.finished && record.objectId) {
          return { objectId: record.objectId, sha256: record.sha256, size: record.size, format: record.format }
        }
        const completed = { ...record, objectId, finished: true }
        if (!record.objectId) await writeJson(recordPath, { ...record, objectId, finished: false })
        await mkdir(join(objects, ownerId), { recursive: true, mode: 0o700 })
        await writeJson(join(objects, ownerId, `${objectId}.json`), completed)
        await writeJson(recordPath, completed)
        return { objectId, sha256: record.sha256, size: record.size, format: record.format }
      })
    },

    async openObject(input) {
      return this.downloadObject(input)
    },

    async downloadObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      const record = await readJson(objectPath(ownerId, objectId))
      if (!record || record.ownerId !== ownerId || record.finished !== true || record.state === 'trash') reject('NOT_FOUND', 404)
      const bytes = await readFile(join(blobs, record.sha256))
      if (digest(bytes) !== record.sha256) reject('HASH_MISMATCH', 500)
      return { bytes, sha256: record.sha256, size: record.size, format: record.format }
    },

    async trashObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const path = objectPath(ownerId, objectId)
        const record = await readJson(path)
        if (!record || record.ownerId !== ownerId || record.finished !== true) reject('NOT_FOUND', 404)
        if (record.state !== 'trash') await writeJson(path, { ...record, state: 'trash' })
        return { objectId, state: 'trash' }
      })
    },

    async restoreObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const path = objectPath(ownerId, objectId)
        const record = await readJson(path)
        if (!record || record.ownerId !== ownerId || record.state !== 'trash') reject('NOT_FOUND', 404)
        const restored = { ...record }
        delete restored.state
        await writeJson(path, restored)
        return { objectId, state: 'active' }
      })
    },

    async purgeObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const path = objectPath(ownerId, objectId)
        const record = await readJson(path)
        if (!record || record.ownerId !== ownerId || record.state !== 'trash') reject('NOT_FOUND', 404)
        await rm(path, { force: true })
        await exclusiveSha(record.sha256, async () => {
          if (!(await blobStillNeeded(record.sha256))) await rm(join(blobs, record.sha256), { force: true })
        })
        return { objectId, state: 'purged' }
      })
    },
  }
}
