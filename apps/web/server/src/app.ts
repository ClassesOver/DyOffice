import type { FastifyInstance, HTTPMethods } from 'fastify'
import { createApplicationHandler } from '../application.mjs'
import { isStoreReady } from '../health.mjs'
import type { WebConfig } from './config.ts'
import { registerHealthRoutes } from './modules/health/routes.ts'
import { registerLegacyRoutes } from './modules/legacy/routes.ts'
import { createApiShell } from './framework.ts'
import type { Pool } from 'pg'
import { assertRuntimePool, assertSharedDatabase } from './db/roles.ts'
import { createPrincipalTransactions } from './db/context.ts'
import { createPreferenceService } from './modules/preferences/service.ts'
import { registerPreferenceRoutes } from './modules/preferences/routes.ts'
import type { IdentityStore } from './db/identity.ts'
import { createPasswordService, loadPasswordBlocklist, type PasswordService } from './modules/auth/passwords.ts'
import { createAccountService } from './modules/auth/service.ts'
import { createSessionService, authError } from './modules/auth/sessions.ts'
import { createCsrfService, cookies } from './modules/auth/csrf.ts'
import { createLoginThrottle, type LoginLimits } from './modules/auth/throttle.ts'
import { registerAuthRoutes } from './modules/auth/routes.ts'
import { createUserService } from './modules/admin/users/service.ts'
import { registerUserRoutes } from './modules/admin/users/routes.ts'

export async function buildApp(config: WebConfig): Promise<FastifyInstance> {
  const { handleRequest, store } = await createApplicationHandler(config)
  const app = await createApiShell(config.rateLimit)
  registerHealthRoutes(app, () => isStoreReady(config.directory, store))
  registerLegacyRoutes(app, handleRequest)
  await app.ready()
  return app
}

export interface LocalWebConfig {
  db: IdentityStore; businessPool?: Pool; deploymentId: string; origin: string; csrfKey: string; passwords?: PasswordService;
  passwordBlocklistFile?: string; loginLimits?: LoginLimits; idleMs?: number; absoluteMs?: number; closeDb?: () => Promise<void>
}
export async function buildLocalApp(config: LocalWebConfig): Promise<FastifyInstance> {
  if (process.env.NODE_ENV === 'production') throw new Error('Local runtime is not allowed in production before enterprise release gates')
  if ('userToken' in config || 'adminToken' in config) throw new Error('Local mode rejects development tokens')
  async function assertReady() {
    await config.db.assertCurrent()
    const result = await config.db.pool.query('SELECT 1 FROM deployments WHERE id=$1 AND bootstrap_completed=true', [config.deploymentId])
    if (!result.rowCount) throw new Error('Local deployment has not been bootstrapped')
  }
  await assertReady()
  if (config.businessPool) {
    await assertRuntimePool(config.db.pool, 'auth')
    await assertRuntimePool(config.businessPool, 'business')
    await assertSharedDatabase(config.db.pool, config.businessPool)
  }
  const passwords = config.passwords ?? await createPasswordService({ blockedPasswords: await loadPasswordBlocklist(config.passwordBlocklistFile) })
  const accounts = createAccountService({ db: config.db, passwords, deploymentId: config.deploymentId })
  const sessions = createSessionService({ db: config.db, accounts, deploymentId: config.deploymentId, idleMs: config.idleMs, absoluteMs: config.absoluteMs })
  const csrf = createCsrfService({ db: config.db, deploymentId: config.deploymentId, origin: config.origin, key: config.csrfKey })
  const throttle = createLoginThrottle(config.db, config.deploymentId, config.csrfKey, config.loginLimits)
  const app = await createApiShell()
  if (config.closeDb) app.addHook('onClose', () => config.closeDb!())
  registerHealthRoutes(app, async () => { try { await assertReady(); return true } catch { return false } })
  const users = createUserService({ db: config.db, accounts, sessions, passwords, deploymentId: config.deploymentId })
  registerAuthRoutes(app, { sessions, csrf, throttle, users })
  registerUserRoutes(app, users, csrf)
  if (config.businessPool) {
    const transactions = createPrincipalTransactions({ pool: config.businessPool, deploymentId: config.deploymentId, idleMs: config.idleMs })
    registerPreferenceRoutes(app, createPreferenceService(transactions), sessions, csrf)
  }
  app.route({
    method: app.supportedMethods as HTTPMethods[], url: '/*',
    onRequest: async request => {
      if (request.url.startsWith('/api/')) {
        await sessions.authenticate(cookies(request).session ?? '')
        throw authError(501) // T04+ must implement isolated resources; never fall back to JSON.
      }
      throw authError(404)
    },
    handler: async () => { throw authError(404) },
  })
  await app.ready()
  return app
}
