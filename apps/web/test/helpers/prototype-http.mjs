import { buildApp } from './prototype-app.mjs'
import { createLegacyContext } from '../../server/src/legacy-context.mjs'

const DEV_LIMIT = { max: 5000, windowMs: 60_000 }

export async function createApplication(options) {
  if (process.env.NODE_ENV === 'production') throw new Error('Development token server is not allowed in production')
  const context = await createLegacyContext(options)
  const app = await buildApp({
    env: 'development',
    logger: false,
    rateLimit: options.rateLimit ?? DEV_LIMIT,
    readyCheck: () => context.ready(),
    legacy: context,
  })
  await app.ready()
  return app.server
}
