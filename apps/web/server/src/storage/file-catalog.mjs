import { assertOwnerId } from './validation.mjs'

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertDeploymentId(deploymentId) {
  if (typeof deploymentId !== 'string' || !UUID.test(deploymentId)) reject('UNSAFE_DEPLOYMENT')
  return deploymentId
}

const INSERT_FILE = `INSERT INTO dyoffice_files
  (id, deployment_id, owner_user_id, object_key, sha256, size_bytes, format, name, state)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`

const SELECT_ACTIVE = `SELECT id, object_key, sha256, size_bytes, format, name, state
  FROM dyoffice_files
  WHERE deployment_id = $1 AND owner_user_id = $2 AND id = $3 AND state = 'active'`

const MARK_TRASH = `UPDATE dyoffice_files
  SET state = 'trash', trashed_at = now()
  WHERE deployment_id = $1 AND owner_user_id = $2 AND id = $3 AND state = 'active'`

/**
 * File rows point at objects that are already stored.
 * Owner filtering here is application code. Database RLS is pending T04.
 * enforcement is always 'pending-t04' so callers cannot treat this as isolation.
 */
export function createFileCatalog({ db, objectStore } = {}) {
  if (!db || typeof db.query !== 'function') reject('UNSAFE_DATABASE')
  if (!objectStore || typeof objectStore.stageUpload !== 'function') reject('UNSAFE_STORE')
  const scope = { enforcement: 'pending-t04' }

  return {
    scope,
    async saveNewFile({ deploymentId, ownerId, name, bytes }) {
      assertDeploymentId(deploymentId)
      assertOwnerId(ownerId)
      const staged = await objectStore.stageUpload({ ownerId, name, bytes })
      const finished = await objectStore.finishUpload({ ownerId, uploadId: staged.uploadId })
      try {
        await db.query(INSERT_FILE, [
          finished.objectId,
          deploymentId,
          ownerId,
          `blobs/${finished.sha256}`,
          finished.sha256,
          finished.size,
          finished.format,
          name,
        ])
      } catch (error) {
        throw Object.assign(new Error('METADATA_FAILED'), { code: 'METADATA_FAILED', status: 500, cause: error })
      }
      return { fileId: finished.objectId, sha256: finished.sha256, size: finished.size, format: finished.format, scope }
    },

    async downloadFile({ deploymentId, ownerId, fileId }) {
      assertDeploymentId(deploymentId)
      assertOwnerId(ownerId)
      if (typeof fileId !== 'string' || !UUID.test(fileId)) reject('NOT_FOUND', 404)
      const found = await db.query(SELECT_ACTIVE, [deploymentId, ownerId, fileId])
      const row = found.rows?.[0]
      if (!row) reject('NOT_FOUND', 404)
      const opened = await objectStore.downloadObject({ ownerId, objectId: fileId })
      if (opened.sha256 !== row.sha256) reject('HASH_MISMATCH', 500)
      return { ...opened, scope }
    },

    async trashFile({ deploymentId, ownerId, fileId }) {
      assertDeploymentId(deploymentId)
      assertOwnerId(ownerId)
      if (typeof fileId !== 'string' || !UUID.test(fileId)) reject('NOT_FOUND', 404)
      const updated = await db.query(MARK_TRASH, [deploymentId, ownerId, fileId])
      if (!updated.rowCount) reject('NOT_FOUND', 404)
      await objectStore.trashObject({ ownerId, objectId: fileId })
      return { fileId, state: 'trash', scope }
    },
  }
}
