import { createHash, randomUUID } from 'node:crypto'
import {
  assertFileId,
  assertIdempotencyKey,
  assertLeaseEpoch,
  assertPrincipal,
  assertRevisionId,
  assertSourceCommand,
  assertUploadId,
  revisionError,
} from './errors.mjs'

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

function refOf(fileId, row) {
  return { fileId, revision: row.revision, sha256: row.sha256, size: row.size }
}

function owns(file, principal) {
  return Boolean(file) && file.ownerId === principal.ownerId && file.deploymentId === principal.deploymentId
}

function requireOwned(snapshot, principal, fileId) {
  const file = snapshot.files[fileId]
  if (!owns(file, principal)) throw revisionError('NOT_FOUND', 404)
  return file
}

function findRow(snapshot, fileId, revision) {
  return (snapshot.revisions[fileId] || []).find((row) => row.revision === revision) || null
}

function assertWritableLease(snapshot, principal, fileId, leaseEpoch, at) {
  const lease = snapshot.leases[fileId]
  const current = lease?.epoch ?? 1
  if (current !== leaseEpoch) throw revisionError('LEASE_CONFLICT', 409)
  if (!lease || lease.sessionId == null) {
    if (leaseEpoch !== 1) throw revisionError('LEASE_CONFLICT', 409)
    return
  }
  if (lease.sessionId !== principal.sessionId || lease.ownerId !== principal.ownerId || lease.deploymentId !== principal.deploymentId) {
    throw revisionError('LEASE_CONFLICT', 409)
  }
  if (typeof lease.expiresAt !== 'number' || lease.expiresAt <= at) throw revisionError('LEASE_CONFLICT', 409)
}

function reservation(snapshot, principal, fileId, uploadId) {
  const reserved = snapshot.uploads[uploadId]
  if (!reserved || reserved.fileId !== fileId || reserved.ownerId !== principal.ownerId || reserved.deploymentId !== principal.deploymentId) {
    throw revisionError('NOT_FOUND', 404, '上传内容不存在')
  }
}

function replayOf(snapshot, principal, fileId, idempotencyKey, payloadHash) {
  const saved = snapshot.idempotency[fileId]?.[idempotencyKey]
  if (!saved) return null
  if (saved.ownerId !== principal.ownerId || saved.deploymentId !== principal.deploymentId) throw revisionError('NOT_FOUND', 404)
  if (saved.payloadHash !== payloadHash) throw revisionError('IDEMPOTENCY_CONFLICT', 409)
  const row = findRow(snapshot, fileId, saved.revision)
  if (!row) throw revisionError('HASH_MISMATCH', 503)
  return { ref: refOf(fileId, row), replayed: true, objectId: row.objectId }
}

function remember(snapshot, principal, fileId, idempotencyKey, payloadHash, revision) {
  const bucket = snapshot.idempotency[fileId] || (snapshot.idempotency[fileId] = {})
  bucket[idempotencyKey] = {
    ownerId: principal.ownerId,
    deploymentId: principal.deploymentId,
    payloadHash,
    revision,
  }
}

function applyCommit(snapshot, principal, spec) {
  const file = requireOwned(snapshot, principal, spec.fileId)
  assertWritableLease(snapshot, principal, spec.fileId, spec.leaseEpoch, spec.now)
  if (file.revision !== spec.baseRevision) throw revisionError('REVISION_CONFLICT', 409)
  if (!spec.forceNew && spec.object.sha256 === file.sha256) {
    remember(snapshot, principal, spec.fileId, spec.idempotencyKey, spec.payloadHash, file.revision)
    return { ref: refOf(spec.fileId, file), replayed: false, objectId: file.objectId }
  }
  const revision = `rev_${randomUUID().replaceAll('-', '')}`
  const row = {
    revision,
    parentRevision: file.revision,
    objectId: spec.object.objectId,
    sha256: spec.object.sha256,
    size: spec.object.size,
    sourceCommandId: spec.sourceCommandId ?? null,
    reason: spec.reason,
    createdAt: spec.now,
  }
  const history = snapshot.revisions[spec.fileId] || (snapshot.revisions[spec.fileId] = [])
  history.push(row)
  file.revision = revision
  file.sha256 = row.sha256
  file.size = row.size
  file.objectId = row.objectId
  remember(snapshot, principal, spec.fileId, spec.idempotencyKey, spec.payloadHash, revision)
  snapshot.outbox.push({
    id: randomUUID(),
    type: 'revision.committed',
    deploymentId: principal.deploymentId,
    ownerId: principal.ownerId,
    fileId: spec.fileId,
    revision,
    objectId: row.objectId,
    sha256: row.sha256,
    createdAt: spec.now,
  })
  return { ref: refOf(spec.fileId, row), replayed: false, objectId: row.objectId }
}

async function readableObject(objects, ownerId, objectId, sha256, size) {
  let opened
  try {
    opened = await objects.downloadObject({ ownerId, objectId })
  } catch (error) {
    if (error?.code === 'NOT_FOUND') throw revisionError('HASH_MISMATCH', 503)
    throw error
  }
  if (opened.sha256 !== sha256 || opened.size !== size) throw revisionError('HASH_MISMATCH', 503)
  return opened
}

/**
 * commitRevision, history, and restore. The caller supplies the server principal.
 * Bytes must already be durable in the object store before the journal transaction
 * publishes a revision. A journal failure leaves an unreferenced object, never a
 * revision whose object is missing.
 */
export function createRevisionService({ journal, objects, now = () => Date.now() } = {}) {
  if (!journal || typeof journal.transaction !== 'function' || !objects) throw new TypeError('revision journal and object store are required')

  return {
    async registerHead(principal, { fileId, name, bytes }) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      if (typeof name !== 'string' || !Buffer.isBuffer(bytes)) throw revisionError('INVALID', 400)
      const current = journal.read().files[id]
      if (current) {
        if (!owns(current, owner)) throw revisionError('NOT_FOUND', 404)
        return refOf(id, current)
      }
      const staged = await objects.stageUpload({ ownerId: owner.ownerId, name, bytes })
      const finished = await objects.finishUpload({ ownerId: owner.ownerId, uploadId: staged.uploadId })
      await readableObject(objects, owner.ownerId, finished.objectId, finished.sha256, finished.size)
      return journal.transaction(id, (snapshot) => {
        const raced = snapshot.files[id]
        if (raced) {
          if (!owns(raced, owner)) throw revisionError('NOT_FOUND', 404)
          return refOf(id, raced)
        }
        const revision = `sha256:${finished.sha256}`
        const row = {
          revision,
          parentRevision: null,
          objectId: finished.objectId,
          sha256: finished.sha256,
          size: finished.size,
          sourceCommandId: null,
          reason: 'import',
          createdAt: now(),
        }
        snapshot.files[id] = {
          fileId: id,
          ownerId: owner.ownerId,
          deploymentId: owner.deploymentId,
          format: finished.format,
          name,
          revision,
          sha256: finished.sha256,
          size: finished.size,
          objectId: finished.objectId,
        }
        snapshot.revisions[id] = [row]
        return refOf(id, row)
      })
    },

    async noteUpload(principal, { fileId, uploadId }) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const upload = assertUploadId(uploadId)
      return journal.transaction(id, (snapshot) => {
        requireOwned(snapshot, owner, id)
        const existing = snapshot.uploads[upload]
        if (existing && (existing.fileId !== id || existing.ownerId !== owner.ownerId || existing.deploymentId !== owner.deploymentId)) {
          throw revisionError('NOT_FOUND', 404, '上传内容不存在')
        }
        snapshot.uploads[upload] = { fileId: id, ownerId: owner.ownerId, deploymentId: owner.deploymentId }
        return { uploadId: upload, fileId: id }
      })
    },

    async commitRevision(principal, input, options = {}) {
      const owner = assertPrincipal(principal)
      const fileId = assertFileId(input?.fileId)
      const uploadId = assertUploadId(input?.uploadId)
      const baseRevision = assertRevisionId(input?.baseRevision)
      const idempotencyKey = assertIdempotencyKey(input?.idempotencyKey)
      const leaseEpoch = assertLeaseEpoch(input?.leaseEpoch)
      const sourceCommandId = assertSourceCommand(input?.sourceCommandId)
      const known = journal.read()
      reservation(known, owner, fileId, uploadId)
      requireOwned(known, owner, fileId)
      let finished
      try {
        finished = await objects.finishUpload({ ownerId: owner.ownerId, uploadId })
      } catch (error) {
        if (error?.code === 'NOT_FOUND') throw revisionError('NOT_FOUND', 404, '上传内容不存在')
        throw error
      }
      await readableObject(objects, owner.ownerId, finished.objectId, finished.sha256, finished.size)
      return journal.transaction(fileId, async (snapshot) => {
        reservation(snapshot, owner, fileId, uploadId)
        const replay = replayOf(snapshot, owner, fileId, idempotencyKey, finished.sha256)
        if (replay) return replay
        if (options.beforeJournalCommit) await options.beforeJournalCommit()
        return applyCommit(snapshot, owner, {
          fileId,
          baseRevision,
          leaseEpoch,
          idempotencyKey,
          sourceCommandId,
          payloadHash: finished.sha256,
          object: { objectId: finished.objectId, sha256: finished.sha256, size: finished.size },
          forceNew: false,
          reason: 'commit',
          now: now(),
        })
      })
    },

    async restoreRevision(principal, input, options = {}) {
      const owner = assertPrincipal(principal)
      const fileId = assertFileId(input?.fileId)
      const sourceRevision = assertRevisionId(input?.sourceRevision)
      const baseRevision = assertRevisionId(input?.baseRevision)
      const leaseEpoch = assertLeaseEpoch(input?.leaseEpoch)
      const idempotencyKey = assertIdempotencyKey(input?.idempotencyKey)
      const known = journal.read()
      requireOwned(known, owner, fileId)
      const source = findRow(known, fileId, sourceRevision)
      if (!source) throw revisionError('NOT_FOUND', 404, '版本不存在')
      await readableObject(objects, owner.ownerId, source.objectId, source.sha256, source.size)
      const payloadHash = digest(`restore\n${sourceRevision}\n${source.sha256}`)
      return journal.transaction(fileId, async (snapshot) => {
        const replay = replayOf(snapshot, owner, fileId, idempotencyKey, payloadHash)
        if (replay) return replay
        if (!findRow(snapshot, fileId, sourceRevision)) throw revisionError('NOT_FOUND', 404, '版本不存在')
        if (options.beforeJournalCommit) await options.beforeJournalCommit()
        return applyCommit(snapshot, owner, {
          fileId,
          baseRevision,
          leaseEpoch,
          idempotencyKey,
          payloadHash,
          object: { objectId: source.objectId, sha256: source.sha256, size: source.size },
          forceNew: true,
          reason: 'restore',
          now: now(),
        })
      })
    },

    current(principal, fileId) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const file = journal.read().files[id]
      if (!file) return null
      if (!owns(file, owner)) throw revisionError('NOT_FOUND', 404)
      return refOf(id, file)
    },

    readRevision(principal, fileId, revision) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const revisionId = assertRevisionId(revision)
      const snapshot = journal.read()
      const file = snapshot.files[id]
      if (!file) return null
      if (!owns(file, owner)) throw revisionError('NOT_FOUND', 404)
      const row = findRow(snapshot, id, revisionId)
      return row ? { ...row } : null
    },

    listRevisions(principal, fileId) {
      const owner = assertPrincipal(principal)
      const id = assertFileId(fileId)
      const snapshot = journal.read()
      requireOwned(snapshot, owner, id)
      return (snapshot.revisions[id] || []).map((row) => ({ ...row }))
    },
  }
}
