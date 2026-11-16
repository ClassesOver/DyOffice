import { access, constants } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createStaticAssets } from '../static-assets.mjs'
import { createStore } from '../store.mjs'
import { DEV_PERSONAL_OWNER, objectStoreDirectory } from './modules/objects/routes.mjs'
import { createLocalObjectStore } from './storage/local-dev.mjs'

export async function createLegacyContext({ directory, userToken, adminToken, encryptionKey, assetMode, assetDirectory, objectQuota }) {
  if (!userToken || !adminToken || userToken === adminToken) {
    throw new Error('Personal and admin tokens must be distinct and nonempty')
  }
  const serveStatic = await createStaticAssets({ assetMode, assetDirectory })
  const store = await createStore(directory, encryptionKey)
  const filePath = join(directory, 'files')
  await mkdir(filePath, { recursive: true, mode: 0o700 })
  const maxObjectBytes = objectQuota?.maxObjectBytes ?? 50 * 1024 * 1024
  const maxOwnerBytes = objectQuota?.maxOwnerBytes ?? 512 * 1024 * 1024
  const objectStore = await createLocalObjectStore({
    directory: objectStoreDirectory(directory),
    maxObjectBytes,
    maxOwnerBytes,
  })
  return {
    directory,
    credentials: { userToken, adminToken },
    store,
    filePath,
    objectStore,
    objectOwnerId: DEV_PERSONAL_OWNER,
    objectMaxBytes: maxObjectBytes,
    serveStatic,
    async ready() {
      try {
        await access(directory, constants.R_OK | constants.W_OK)
        const snapshot = store.read()
        return Boolean(snapshot && Array.isArray(snapshot.files) && snapshot.preferences)
      } catch {
        return false
      }
    },
  }
}
