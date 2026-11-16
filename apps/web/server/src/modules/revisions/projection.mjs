import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { revisionError } from './errors.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeAtomic(directory, fileId, bytes) {
  const target = join(directory, fileId)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  try {
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** Copy a committed object onto the legacy current-file path. The journal remains the revision authority. */
export async function projectCommittedBytes({ store, filePath, fileId, bytes }) {
  const next = sha256(bytes)
  let previous = null
  try {
    previous = await readFile(join(filePath, fileId))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!previous || sha256(previous) !== next) await writeAtomic(filePath, fileId, bytes)
  await store.update((state) => {
    const file = state.files.find((entry) => entry.id === fileId)
    if (!file) return
    file.size = bytes.length
    file.updatedAt = new Date().toISOString()
  })
}

/**
 * Copy the ledger's current head onto the legacy file. A replayed older
 * revision must not be the bytes that get written. The read and the write
 * share the journal queue, so a newer commit cannot land underneath them.
 */
export async function projectCurrentHead({ journal, objects, ownerId, deploymentId, store, filePath, fileId }) {
  await journal.transaction(fileId, async (snapshot) => {
    const file = snapshot.files[fileId]
    if (!file || file.ownerId !== ownerId || (deploymentId !== undefined && file.deploymentId !== deploymentId)) return
    const opened = await objects.downloadObject({ ownerId, objectId: file.objectId })
    if (opened.sha256 !== file.sha256) throw revisionError('HASH_MISMATCH', 503)
    await projectCommittedBytes({ store, filePath, fileId, bytes: opened.bytes })
  })
}
