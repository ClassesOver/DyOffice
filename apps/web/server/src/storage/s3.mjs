import { createHash, randomUUID } from 'node:crypto'
import { assertOwnerId, validateOfficeObject } from './validation.mjs'

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status })
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
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

const DEFAULT_STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Object store on an S3-shaped client. The supplied client may be the
 * in-process fake. This is not highly available storage and it does not
 * enforce database row-level security. The caller passes the server owner id.
 * A client ETag is never stored or trusted as the content hash.
 * Abandoned staged uploads expire the same way as the local disk store.
 */
export function createS3ObjectStore({
  client, maxObjectBytes, maxOwnerBytes, afterBytesWritten, afterReferencePublished, beforeObjectPublished,
  stagedUploadTtlMs = DEFAULT_STAGED_UPLOAD_TTL_MS, now = Date.now,
} = {}) {
  if (!client || typeof client.put !== 'function' || typeof client.get !== 'function') reject('UNSAFE_CLIENT')
  if (!Number.isSafeInteger(stagedUploadTtlMs) || stagedUploadTtlMs < 1000) reject('UNSAFE_TTL')
  if (typeof now !== 'function') reject('UNSAFE_TTL')
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) reject('UNSAFE_QUOTA')
  if (!Number.isSafeInteger(maxOwnerBytes) || maxOwnerBytes < maxObjectBytes) reject('UNSAFE_QUOTA')
  const exclusive = createExclusive()
  const exclusiveSha = createExclusive()

  async function readJson(key) {
    const bytes = await client.get(key)
    if (!bytes) return null
    return JSON.parse(bytes.toString('utf8'))
  }

  async function writeJson(key, value) {
    await client.put(key, Buffer.from(JSON.stringify(value)))
  }

  function stagingKey(ownerId, uploadId) {
    return `staging/${ownerId}/${uploadId}.json`
  }

  function objectKey(ownerId, objectId) {
    return `objects/${ownerId}/${objectId}.json`
  }

  function blobKey(sha256) {
    return `blobs/${sha256}`
  }

  function isExpiredStage(record) {
    return record.finished !== true && Number.isSafeInteger(record.stagedAt) &&
      now() - record.stagedAt > stagedUploadTtlMs
  }

  async function recordsUnder(prefix, include) {
    const found = []
    for (const key of await client.list(prefix)) {
      if (!key.endsWith('.json')) continue
      const record = await readJson(key)
      if (record && include(record)) found.push(record)
    }
    return found
  }

  async function blobStillNeeded(sha256) {
    const staged = await recordsUnder('staging/', (record) => record.sha256 === sha256 && record.finished !== true && !isExpiredStage(record))
    if (staged.length > 0) return true
    const kept = await recordsUnder('objects/', (record) => record.sha256 === sha256)
    return kept.length > 0
  }

  async function ownerBytes(ownerId) {
    let total = 0
    for (const prefix of [`staging/${ownerId}/`, `objects/${ownerId}/`]) {
      for (const key of await client.list(prefix)) {
        if (!key.endsWith('.json')) continue
        const record = await readJson(key)
        if (!record || !Number.isSafeInteger(record.size)) continue
        if (prefix.startsWith('staging/') && (record.finished || isExpiredStage(record))) continue
        total += record.size
      }
    }
    return total
  }

  async function sweepExpiredStages(ownerId) {
    for (const key of await client.list(`staging/${ownerId}/`)) {
      if (!key.endsWith('.json')) continue
      const record = await readJson(key)
      if (!record || !isExpiredStage(record)) continue
      await client.delete(key)
      if (typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256)) {
        await exclusiveSha(record.sha256, async () => {
          if (!(await blobStillNeeded(record.sha256))) await client.delete(blobKey(record.sha256))
        })
      }
    }
  }

  return {
    async stageUpload({ ownerId, name, bytes }) {
      assertOwnerId(ownerId)
      const { format } = validateOfficeObject({ name, bytes, maxBytes: maxObjectBytes })
      return exclusive(ownerId, async () => {
        await sweepExpiredStages(ownerId)
        const used = await ownerBytes(ownerId)
        if (used + bytes.length > maxOwnerBytes) reject('QUOTA')
        const uploadId = randomUUID()
        const sha256 = digest(bytes)
        const recordKey = stagingKey(ownerId, uploadId)
        if (afterBytesWritten) await afterBytesWritten()
        let published = false
        try {
          await writeJson(recordKey, {
            uploadId, ownerId, name, format, size: bytes.length, sha256, finished: false, stagedAt: now(),
          })
          published = true
          if (afterReferencePublished) await afterReferencePublished()
          await exclusiveSha(sha256, () => client.put(blobKey(sha256), bytes, { immutable: true }))
        } catch (error) {
          if (published) await client.delete(recordKey)
          throw error
        }
        return { uploadId, sha256, size: bytes.length, format, finished: false }
      })
    },

    async finishUpload({ ownerId, uploadId }) {
      assertOwnerId(ownerId)
      if (typeof uploadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(uploadId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const recordKey = stagingKey(ownerId, uploadId)
        const record = await readJson(recordKey)
        if (!record || record.ownerId !== ownerId) reject('NOT_FOUND', 404)
        const objectId = record.objectId ?? randomUUID()
        if (record.finished && record.objectId) {
          return { objectId: record.objectId, sha256: record.sha256, size: record.size, format: record.format }
        }
        return exclusiveSha(record.sha256, async () => {
          if (isExpiredStage(record)) reject('NOT_FOUND', 404)
          if (beforeObjectPublished) await beforeObjectPublished()
          const completed = { ...record, objectId, finished: true }
          if (!record.objectId) await writeJson(recordKey, { ...record, objectId, finished: false })
          await writeJson(objectKey(ownerId, objectId), completed)
          await writeJson(recordKey, completed)
          return { objectId, sha256: record.sha256, size: record.size, format: record.format }
        })
      })
    },

    async openObject(input) {
      return this.downloadObject(input)
    },

    async downloadObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      const record = await readJson(objectKey(ownerId, objectId))
      if (!record || record.ownerId !== ownerId || record.finished !== true || record.state === 'trash') reject('NOT_FOUND', 404)
      const bytes = await client.get(blobKey(record.sha256))
      if (!bytes || digest(bytes) !== record.sha256) reject('HASH_MISMATCH', 500)
      return { bytes, name: record.name, sha256: record.sha256, size: record.size, format: record.format }
    },

    async trashObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const key = objectKey(ownerId, objectId)
        const record = await readJson(key)
        if (!record || record.ownerId !== ownerId || record.finished !== true) reject('NOT_FOUND', 404)
        if (record.state !== 'trash') await writeJson(key, { ...record, state: 'trash' })
        return { objectId, state: 'trash' }
      })
    },

    async restoreObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const key = objectKey(ownerId, objectId)
        const record = await readJson(key)
        if (!record || record.ownerId !== ownerId || record.state !== 'trash') reject('NOT_FOUND', 404)
        const restored = { ...record }
        delete restored.state
        await writeJson(key, restored)
        return { objectId, state: 'active' }
      })
    },

    async purgeObject({ ownerId, objectId }) {
      assertOwnerId(ownerId)
      if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) reject('NOT_FOUND', 404)
      return exclusive(ownerId, async () => {
        const key = objectKey(ownerId, objectId)
        const record = await readJson(key)
        if (!record || record.ownerId !== ownerId || record.state !== 'trash') reject('NOT_FOUND', 404)
        await client.delete(key)
        await exclusiveSha(record.sha256, async () => {
          if (!(await blobStillNeeded(record.sha256))) await client.delete(blobKey(record.sha256))
        })
        return { objectId, state: 'purged' }
      })
    },
  }
}
