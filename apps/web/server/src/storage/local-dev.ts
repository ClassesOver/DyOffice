import { mkdir, lstat, realpath, open, link, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertObjectReference, collectVerified, objectReference, storageError, type ObjectStore } from './object-store.ts'

// Development only: one dedicated directory owned by the service account.
// Never share this adapter across replicas or with another local writer.
export async function createLocalObjectStore({ directory }: { directory: string }): Promise<ObjectStore> {
  const root = resolve(directory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  async function assertDirectory() {
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw storageError()
  }
  await assertDirectory()
  const path = (key: string) => join(root, key.replaceAll('/', '_'))
  return {
    async putImmutable(key, bytes) {
      const reference = objectReference(key, bytes)
      bytes = Buffer.from(bytes)
      await assertDirectory()
      const temporary = join(root, '.staging-' + randomUUID())
      let handle
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined
        // Hard-link publication is atomic and fails if the key already exists.
        await link(temporary, path(key))
        const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await parent.sync() } finally { await parent.close() }
        return reference
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw storageError(409)
        throw storageError()
      } finally {
        await handle?.close()
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw storageError() })
      }
    },
    async readVerified(reference) {
      assertObjectReference(reference)
      try {
        await assertDirectory()
        const handle = await open(path(reference.key), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size !== reference.size) throw storageError()
          return await collectVerified(handle.createReadStream({ autoClose: false }), reference)
        } finally { await handle.close() }
      } catch { throw storageError() }
    },
  }
}
