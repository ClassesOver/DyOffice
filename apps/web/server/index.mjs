import { resolve } from 'node:path'
import { buildApp } from './src/app.mjs'
import { createLegacyContext } from './src/legacy-context.mjs'

if (process.env.NODE_ENV === 'production') {
  throw new Error('Development token server is not allowed in production')
}

const context = await createLegacyContext({
  directory: resolve(process.env.DYOFFICE_DATA_DIR || '.dyoffice'),
  userToken: process.env.DYOFFICE_USER_TOKEN,
  adminToken: process.env.DYOFFICE_ADMIN_TOKEN,
  encryptionKey: process.env.DYOFFICE_ENCRYPTION_KEY,
  assetMode: process.env.DYOFFICE_ASSET_MODE || 'built',
})
const app = await buildApp({
  env: 'development',
  logger: false,
  rateLimit: { max: 600, windowMs: 60_000 },
  readyCheck: () => context.ready(),
  legacy: context,
})
const port = Number(process.env.PORT || 3080)
const host = process.env.HOST || '127.0.0.1'
await app.listen({ port, host })
console.log(`dyoffice: http://${host}:${port}`)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    app.close().then(() => process.exit(0), () => process.exit(1))
  })
}
