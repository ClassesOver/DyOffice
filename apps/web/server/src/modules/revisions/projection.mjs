import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
