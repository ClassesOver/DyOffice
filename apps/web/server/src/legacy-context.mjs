import { access, constants } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createStaticAssets } from '../static-assets.mjs'
import { createStore } from '../store.mjs'

export async function createLegacyContext({ directory, userToken, adminToken, encryptionKey, assetMode, assetDirectory }) {
  if (!userToken || !adminToken || userToken === adminToken) {
    throw new Error('Personal and admin tokens must be distinct and nonempty')
  }
  const serveStatic = await createStaticAssets({ assetMode, assetDirectory })
  const store = await createStore(directory, encryptionKey)
  const filePath = join(directory, 'files')
  await mkdir(filePath, { recursive: true, mode: 0o700 })
  return {
    directory,
    credentials: { userToken, adminToken },
    store,
    filePath,
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
