import { createStaticAssets } from '../static-assets.mjs'
import type { FastifyInstance, HTTPMethods } from 'fastify'
import { buildApp as buildModularApp } from './app.mjs'
import { createLegacyContext } from './legacy-context.mjs'
import type { WebConfig } from './config.ts'
import { registerHealthRoutes } from './modules/health/routes.ts'
import { createApiShell } from './framework.ts'
import { registerJobRoutes } from './modules/jobs/routes.ts'
import { createJobService } from './modules/jobs/service.ts'
import { createLeaseService } from './modules/leases/service.ts'
import { createRevisionService } from './modules/revisions/service.ts'
import { createFileService, type FilePolicy } from './modules/files/service.ts'
import { registerFileRoutes } from './modules/files/routes.ts'
import type { ObjectStore } from './storage/object-store.ts'
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
  if (process.env.NODE_ENV === 'production') throw new Error('Development token server is not allowed in production')
  const context = await createLegacyContext({ ...config, assetMode: config.assetMode, assetDirectory: config.assetDirectory, objectQuota: undefined })
  const app = await buildModularApp({
    env: 'development',
    logger: false,
    rateLimit: { max: config.rateLimit?.max ?? 5000, windowMs: config.rateLimit?.timeWindow ?? 60_000 },
    readyCheck: () => context.ready(),
    legacy: context,
  })
  await app.ready()
  return app
}

export interface LocalWebConfig {
  db: IdentityStore; businessPool?: Pool; deploymentId: string; origin: string; csrfKey: string; passwords?: PasswordService;
  objectStore?: ObjectStore; filePolicy?: FilePolicy; nativeDocsDirectory?: string; nativeJobs?: boolean;
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
  if (config.objectStore && !config.businessPool) throw new Error('File API requires restricted business pool')
  if (config.businessPool) {
    await assertRuntimePool(config.db.pool, 'auth')
    await assertRuntimePool(config.businessPool, 'business')
    await assertSharedDatabase(config.db.pool, config.businessPool)
  }
  if (config.nativeJobs!==undefined && typeof config.nativeJobs!=='boolean') throw new Error('Invalid native job configuration')
  if (config.nativeJobs && !config.objectStore) throw new Error('Native jobs require File API')
  if (config.nativeDocsDirectory && !config.objectStore) throw new Error('Native DOCX requires File API')
  const nativeDocs = config.nativeDocsDirectory ? await createStaticAssets({ assetMode: 'built',assetDirectory: config.nativeDocsDirectory,pages: ['index.html'],assetInventory: '.vite/native-assets.json',cacheControl: 'private, no-store' }) : undefined
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
    if (config.objectStore) {
      const files = createFileService({ transactions, objects: config.objectStore, ...config.filePolicy, capabilities: nativeDocs ? { docx: 'editable',xlsx: 'unsupported',pptx: 'unsupported',pdf: 'unsupported' } : undefined })
      const leases = createLeaseService({ transactions })
      const revisions = createRevisionService({ transactions, objects: config.objectStore, files, ...config.filePolicy })
      registerFileRoutes(app,files,sessions,csrf,{ leases, revisions })
      if (config.nativeJobs) registerJobRoutes(app,createJobService({ transactions,enabledTypes: ['xlsx.roundtrip'] }),sessions,csrf)
      if (nativeDocs) app.route({
        method: ['GET','HEAD'], url: '/native-docx/*',
        onRequest: async (request,reply) => {
          reply.raw.setHeader('Cache-Control','private, no-store')
          reply.raw.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
          await sessions.authenticate(cookies(request).session ?? '')
        },
        handler: async (request,reply) => {
          const url = new URL(request.url,config.origin), path = url.pathname.slice('/native-docx'.length)
          if (path === '/' || path === '/index.html') {
            const opened = await files.openFile(cookies(request).session ?? '',url.searchParams.get('fileId') ?? '')
            if (opened.format !== 'docx') throw authError(404)
          }
          // No source fallback and no arbitrary file paths: only verified build assets.
          const response = reply.raw
          const served = await nativeDocs(request.raw,response,path)
          if (!served) throw authError(404)
          reply.hijack()
        },
      })
    }
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
