import type { FastifyInstance } from 'fastify'
import { createAdminProviderPipeline } from './admin-pipeline.ts'
import { registerProviderRoutes } from './routes.ts'

type PipelineOptions = Parameters<typeof createAdminProviderPipeline>[0]
type RouteOptions = Parameters<typeof registerProviderRoutes>[1]
export type AdminProviderAssemblyConfig = { enabled: false } | ({
  enabled: true
  sessions: RouteOptions['sessions']
  csrf: RouteOptions['csrf']
} & PipelineOptions)

/** Trusted bootstrap input only, never request data or environment truthiness.
 * Not called by app.ts. No defaults enable egress, grant budget or add members.
 * The caller must close the app even when ready/listen rejects. */
export function registerAdminProviderAssembly(app: FastifyInstance, config?: AdminProviderAssemblyConfig) {
  const unavailable = () => new Error('Invalid AI assembly')
  if (config === undefined || config?.enabled === false) return { dispose() {} }
  if (config?.enabled !== true) throw unavailable()
  // Validate before copying any keys or scheduling any routes.
  if (!config.transactions || typeof config.transactions.withPrincipalTransaction !== 'function'
    || typeof config.sessions?.authenticate !== 'function' || typeof config.csrf?.requireSession !== 'function') throw unavailable()
  let pipeline: ReturnType<typeof createAdminProviderPipeline>
  try { pipeline = createAdminProviderPipeline(config) } catch { throw unavailable() }
  let disposed = false
  const authenticationStops = new Set<() => void>()
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const stop of authenticationStops) stop()
    authenticationStops.clear()
    pipeline.dispose()
  }
  try {
    // Abort before Fastify waits for in-flight streaming requests to drain.
    app.addHook('preClose', async () => { dispose() })
    app.addHook('onClose', async () => { dispose() })
    registerProviderRoutes(app, { turns: pipeline.turns, sessions: {
      async authenticate(...args) {
        if (disposed) throw unavailable()
        let stop!: () => void
        const stopped = new Promise<never>((_, reject) => {
          stop = () => reject(unavailable())
          authenticationStops.add(stop)
        })
        try {
          const result = await Promise.race([config.sessions.authenticate(...args), stopped])
          if (disposed) throw unavailable()
          return result
        } finally { authenticationStops.delete(stop) }
      },
    }, csrf: config.csrf })
  } catch { dispose(); throw unavailable() }
  return { dispose }
}
