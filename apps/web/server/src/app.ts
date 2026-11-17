import {registerProbeAssets} from './modules/providers/probe-assets.ts'
import { registerFixedProviderProbe } from './modules/providers/fixed-probe.ts'
import type { AdminPipelineProfile } from './modules/providers/admin-pipeline.ts'
import { registerAdminSyntheticProbe } from './modules/providers/synthetic-probe.ts'
import { createSheetsSaveService, type SheetsPlanner, type SheetsSaveNative } from './modules/sheets/save.ts'
import { createSheetsService, type SheetsNative, type SheetsPackageReader } from './modules/sheets/service.ts'
import { registerSheetsRoutes } from './modules/sheets/routes.ts'
import { createSlidesSaveService } from './modules/slides/save.ts'
import { createSlidesService, type SlidesSessionHost } from './modules/slides/service.ts'
import { registerSlidesRoutes } from './modules/slides/routes.ts'
import { createReadinessProbe } from './readiness.ts'
import { createStaticAssets } from '../static-assets.mjs'
import { registerLocalShell } from './local-shell.ts'
import type { FastifyInstance, HTTPMethods } from 'fastify'
import { buildApp as buildModularApp } from './app.mjs'
import { createLegacyContext } from './legacy-context.mjs'
import type { WebConfig } from './config.ts'
import { registerHealthRoutes } from './modules/health/routes.ts'
import { createApiShell } from './framework.ts'
import { registerJobRoutes } from './modules/jobs/routes.ts'
import { createJobService } from './modules/jobs/service.ts'
import { createLeaseService } from './modules/leases/service.ts'
import { registerRealtimeRoutes, type RealtimeServer } from './modules/realtime/routes.ts'
import type { RealtimeCommandPolicy } from './modules/realtime/commands.ts'
import { registerCommandRoutes } from './modules/commands/routes.ts'
import { createCommandRequestFactory } from './modules/commands/http-service.ts'
import type { RealtimeOptions } from './modules/realtime/gateway.ts'
import { createRevisionService } from './modules/revisions/service.ts'
import { createFileService, type FilePolicy } from './modules/files/service.ts'
import { registerFileRoutes } from './modules/files/routes.ts'
import type { ObjectStore } from './storage/object-store.ts'
import type { Pool } from 'pg'
import { assertRuntimePool, assertSharedDatabase } from './db/roles.ts'
import { createPrincipalTransactions } from './db/context.ts'
import { createPreferenceService } from './modules/preferences/service.ts'
import { registerPreferenceRoutes } from './modules/preferences/routes.ts'
import { createWorkspaceService } from './modules/workspace/service.ts'
import { registerWorkspaceRoutes } from './modules/workspace/routes.ts'
import type { IdentityStore } from './db/identity.ts'
import { createPasswordService, loadPasswordBlocklist, type PasswordService } from './modules/auth/passwords.ts'
import { createAccountService } from './modules/auth/service.ts'
import { createSessionService, authError } from './modules/auth/sessions.ts'
import { createCsrfService, cookies } from './modules/auth/csrf.ts'
import { createLoginThrottle, type LoginLimits } from './modules/auth/throttle.ts'
import { registerAuthRoutes } from './modules/auth/routes.ts'
import { createUserService } from './modules/admin/users/service.ts'
import { registerUserRoutes } from './modules/admin/users/routes.ts'
import { createGlobalConfigService } from './modules/admin/service.ts'
import { registerGlobalConfigRoutes } from './modules/admin/routes.ts'
import type { SecretKeyring } from './modules/admin/secrets.ts'
import { createSourceService } from './modules/sources/service.ts'
import { registerSourceRoutes } from './modules/sources/routes.ts'
import { createWorkspaceSourceResults } from './modules/sources/results.ts'
import { createWorkspaceSourceTools, type WorkspaceSourceTools } from './modules/sources/tools.ts'
import { registerWorkspaceSourceToolRoutes } from './modules/sources/tool-routes.ts'
import type { SourceEgressTarget } from './security/egress.ts'

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
  objectStore?: ObjectStore; filePolicy?: FilePolicy; nativeDocsDirectory?: string; nativeSheetsDirectory?: string; nativeSlidesDirectory?: string; slidesHost?: SlidesSessionHost; nativeJobs?: boolean; sheetsNative?: SheetsNative & Partial<SheetsSaveNative>; sheetsPlanner?: SheetsPlanner; sheetsPackageReader?: SheetsPackageReader; localShellDirectory?: string;
  globalConfigKeyring?: SecretKeyring;
  sourcesCredentialKeys?: string;
  sourcesEgressTargets?: readonly SourceEgressTarget[];
  /** Trusted assistant composition; never model-supplied credentials or scope. */
  onSourceToolsReady?: (tools: WorkspaceSourceTools) => void;
  adminAiSyntheticProbe?: boolean;
  // Explicit network-capable fixed probe, NOT the offline diagnostic. No automatic run.
  adminProviderProbeDirectory?: string;
  adminProviderProbe?: { profiles: readonly AdminPipelineProfile[] };
  providerShutdownTimeoutMs?: number;
  /** Notification polling/heartbeat timing; saves remain on the HTTP file API. */
  realtime?: RealtimeOptions;
  /** Explicit trusted composition; no HTTP route can supply policy or dispatch. */
  realtimeCommands?: RealtimeCommandPolicy;
  onRealtimeReady?: (server: RealtimeServer) => void;
  passwordBlocklistFile?: string; loginLimits?: LoginLimits; idleMs?: number; absoluteMs?: number; closeDb?: () => Promise<void>
}
export async function buildLocalApp(config: LocalWebConfig): Promise<FastifyInstance> {
  // No supported OS-isolated PPTX runtime exists yet. Test forks cannot be wired
  // into an HTTP deployment through configuration, in any NODE_ENV.
  if(config.slidesHost || config.nativeSlidesDirectory) throw new Error('PPTX_OS_ISOLATION_UNAVAILABLE')
  if (process.env.NODE_ENV === 'production') throw new Error('Local runtime is not allowed in production before enterprise release gates')
  if (config.adminAiSyntheticProbe !== undefined && typeof config.adminAiSyntheticProbe !== 'boolean') throw new Error('Invalid synthetic probe configuration')
  if (config.adminAiSyntheticProbe && !config.businessPool) throw new Error('Synthetic probe requires restricted business pool')
  if (config.providerShutdownTimeoutMs !== undefined && (!Number.isSafeInteger(config.providerShutdownTimeoutMs) || config.providerShutdownTimeoutMs < 1 || config.providerShutdownTimeoutMs > 35_000)) throw new Error('Invalid provider shutdown timeout')
  if (config.adminProviderProbe !== undefined && (!config.adminProviderProbe || Object.keys(config.adminProviderProbe).join() !== 'profiles' || !Array.isArray(config.adminProviderProbe.profiles) || !config.adminProviderProbe.profiles.length || !config.businessPool || !config.globalConfigKeyring || config.adminProviderProbe.profiles.some(p=>!p || p.deploymentId!==config.deploymentId))) throw new Error('Invalid provider probe configuration')
  if(config.adminProviderProbeDirectory!==undefined && (!config.adminProviderProbe || typeof config.adminProviderProbeDirectory!=='string' || !config.adminProviderProbeDirectory))throw new Error('Probe assets require explicit local probe')
  const probeAssets=config.adminProviderProbeDirectory?await createStaticAssets({assetMode:'built',assetDirectory:config.adminProviderProbeDirectory,pages:['index.html'],cacheControl:'private, no-store'}):undefined
  if ('userToken' in config || 'adminToken' in config) throw new Error('Local mode rejects development tokens')
  async function assertReady() {
    await config.db.assertCurrent()
    const result = await config.db.pool.query('SELECT 1 FROM deployments WHERE id=$1 AND bootstrap_completed=true', [config.deploymentId])
    if (!result.rowCount) throw new Error('Local deployment has not been bootstrapped')
  }
  await assertReady()
  if (config.objectStore && !config.businessPool) throw new Error('File API requires restricted business pool')
  // Authentication is privileged even when no business routes are enabled.
  await assertRuntimePool(config.db.pool, 'auth')
  if (config.businessPool) {
    await assertRuntimePool(config.businessPool, 'business')
    await assertSharedDatabase(config.db.pool, config.businessPool)
  }
  if (config.nativeJobs!==undefined && typeof config.nativeJobs!=='boolean') throw new Error('Invalid native job configuration')
  if (config.sheetsPlanner && (!config.sheetsNative?.savePlan || !config.objectStore)) throw new Error('Sheets saves require native writer and File API')
  if (config.sheetsNative && !config.objectStore) throw new Error('Native sheets require File API')
  if (config.nativeJobs && !config.objectStore) throw new Error('Native jobs require File API')
  if (config.localShellDirectory && !config.objectStore) throw new Error('Local shell requires scoped File API')
  if (config.nativeDocsDirectory && !config.objectStore) throw new Error('Native DOCX requires File API')
  if (config.nativeSheetsDirectory && (!config.objectStore || !config.sheetsNative?.readSheet || !config.sheetsNative?.savePlan || !config.sheetsPlanner || !config.sheetsPackageReader)) throw new Error('Native Sheets requires complete native adapters')
  if (config.nativeSlidesDirectory && !config.objectStore) throw new Error('Native slides require File API')
  if (config.slidesHost && !config.objectStore) throw new Error('Native slides sessions require File API')
  const nativeSheets = config.nativeSheetsDirectory ? await createStaticAssets({assetMode:'built',assetDirectory:config.nativeSheetsDirectory,pages:['index.html'],assetInventory:'.vite/native-assets.json',cacheControl:'private, no-store'}) : undefined
  const nativeSlides = config.nativeSlidesDirectory ? await createStaticAssets({assetMode:'built',assetDirectory:config.nativeSlidesDirectory,pages:['index.html'],assetInventory:'.vite/native-assets.json',cacheControl:'private, no-store'}) : undefined
  const nativeDocs = config.nativeDocsDirectory ? await createStaticAssets({ assetMode: 'built',assetDirectory: config.nativeDocsDirectory,pages: ['index.html'],assetInventory: '.vite/native-assets.json',cacheControl: 'private, no-store' }) : undefined
  const passwords = config.passwords ?? await createPasswordService({ blockedPasswords: await loadPasswordBlocklist(config.passwordBlocklistFile) })
  const accounts = createAccountService({ db: config.db, passwords, deploymentId: config.deploymentId })
  const sessions = createSessionService({ db: config.db, accounts, deploymentId: config.deploymentId, idleMs: config.idleMs, absoluteMs: config.absoluteMs })
  const csrf = createCsrfService({ db: config.db, deploymentId: config.deploymentId, origin: config.origin, key: config.csrfKey })
  // Explicit same-origin WS source is required by browsers that do not include
  // wss in connect-src 'self'. Never grant the unrestricted wss: scheme.
  const realtimeSource = new URL(config.origin)
  realtimeSource.protocol = realtimeSource.protocol === 'https:' ? 'wss:' : 'ws:'
  const nativeConnectSources = `'self' blob: ${realtimeSource.origin}`
  const throttle = createLoginThrottle(config.db, config.deploymentId, config.csrfKey, config.loginLimits)
  const app = await createApiShell()
  try {
  if (config.localShellDirectory) await registerLocalShell(app,config.localShellDirectory)
  const ownedProbes: {dispose():void;drain(options?:{timeoutMs?:number}):Promise<void>}[]=[]
  app.addHook('preClose',async()=>{for(const probe of ownedProbes)probe.dispose()})
  app.addHook('onClose',async()=>{
    for(const probe of ownedProbes)probe.dispose()
    await Promise.all(ownedProbes.map(probe=>probe.drain({timeoutMs:config.providerShutdownTimeoutMs})))
    // Failed/dirty probe drain intentionally skips shared-pool closure.
    if(config.closeDb)await config.closeDb()
  })
  registerHealthRoutes(app, createReadinessProbe({ identityReady: assertReady, businessPool: config.businessPool, objectStore: config.objectStore }))
  const users = createUserService({ db: config.db, accounts, sessions, passwords, deploymentId: config.deploymentId })
  registerAuthRoutes(app, { sessions, csrf, throttle, users })
  registerUserRoutes(app, users, csrf)
  if (config.businessPool) {
    const transactions = createPrincipalTransactions({ pool: config.businessPool, deploymentId: config.deploymentId, idleMs: config.idleMs })
    if (config.adminAiSyntheticProbe === true) ownedProbes.push(registerAdminSyntheticProbe(app, { transactions, sessions, csrf }))
    if(config.adminProviderProbe){
      try{const probe=registerFixedProviderProbe(app,{deploymentId:config.deploymentId,transactions,sessions,csrf,keyring:config.globalConfigKeyring!,profiles:config.adminProviderProbe.profiles});ownedProbes.push(probe);if(probeAssets)registerProbeAssets(app,probeAssets,probe.authorize)}
      catch(error){await app.close();throw error}
    }
    const sources = createSourceService({ transactions, credentialKeys: config.sourcesCredentialKeys, egressTargets: config.sourcesEgressTargets })
    const sourceResults = createWorkspaceSourceResults({ transactions })
    const sourceTools = createWorkspaceSourceTools({ sources, results: sourceResults })
    registerSourceRoutes(app, sources, sessions, csrf)
    registerWorkspaceSourceToolRoutes(app, { tools: sourceTools, results: sourceResults, sessions, csrf })
    config.onSourceToolsReady?.(sourceTools)
    registerPreferenceRoutes(app, createPreferenceService(transactions), sessions, csrf)
    registerWorkspaceRoutes(app, createWorkspaceService(transactions), sessions, csrf)
    registerGlobalConfigRoutes(app, createGlobalConfigService({transactions, keyring: config.globalConfigKeyring}), sessions, csrf)
    if (config.objectStore) {
      const files = createFileService({ transactions, objects: config.objectStore, ...config.filePolicy, capabilities: nativeDocs || nativeSheets || nativeSlides ? { docx: nativeDocs ? 'editable' : 'unsupported',xlsx: nativeSheets ? 'editable' : 'unsupported',pptx: nativeSlides ? 'editable' : 'unsupported',pdf: 'unsupported' } : undefined })
      const leases = createLeaseService({ transactions })
      const revisions = createRevisionService({ transactions, objects: config.objectStore, files, ...config.filePolicy })
      registerFileRoutes(app,files,sessions,csrf,{ leases, revisions })
      // T17 notification/reconciliation only; preClose terminates upgraded
      // sockets before HTTP shutdown waits on their lifetime.
      const realtime = registerRealtimeRoutes(app,{ transactions,sessions,csrf,origin: config.origin,options: config.realtime,commandPolicy: config.realtimeCommands })
      config.onRealtimeReady?.(realtime)
      if (config.realtimeCommands) registerCommandRoutes(app, { sessions,csrf,
        createRequestCommands: createCommandRequestFactory(transactions, config.realtimeCommands.lookupTool) })
      if (config.sheetsNative) {
        const saves = config.sheetsPlanner ? createSheetsSaveService({files,leases,revisions,native:config.sheetsNative as SheetsNative & SheetsSaveNative,plan:config.sheetsPlanner}) : undefined
        registerSheetsRoutes(app,createSheetsService({files,native:config.sheetsNative,readPackage:config.sheetsPackageReader}),sessions,csrf,saves)
      }
      if (config.slidesHost) {
        const slides = createSlidesService({files,leases,revisions,host:config.slidesHost})
        app.addHook('onClose', () => slides.closeAll())
        registerSlidesRoutes(app,slides,sessions,csrf,createSlidesSaveService({files,leases,revisions,sessions:slides}))
      }
      if (config.nativeJobs) registerJobRoutes(app,createJobService({ transactions,enabledTypes: ['xlsx.roundtrip'] }),sessions,csrf)
      if (nativeDocs) app.route({
        method: ['GET','HEAD'], url: '/native-docx/*',
        onRequest: async (request,reply) => {
          reply.raw.setHeader('Cache-Control','private, no-store')
          reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${nativeConnectSources}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
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
      if (nativeSlides) app.route({
        method: ['GET','HEAD'], url: '/native-pptx/*',
        onRequest: async (request,reply) => {
          reply.raw.setHeader('Cache-Control','private, no-store')
          // 'wasm-unsafe-eval' keeps harfbuzzjs font shaping working; media-src covers
          // PPTX-embedded audio/video played through the slides renderer.
          reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${nativeConnectSources}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
          await sessions.authenticate(cookies(request).session ?? '')
        },
        handler: async (request,reply) => {
          const url = new URL(request.url,config.origin), path = url.pathname.slice('/native-pptx'.length)
          if (path === '/' || path === '/index.html') {
            const opened = await files.openFile(cookies(request).session ?? '',url.searchParams.get('fileId') ?? '')
            if (opened.format !== 'pptx') throw authError(404)
          }
          // No source fallback and no arbitrary file paths: only verified build assets.
          const response = reply.raw
          const served = await nativeSlides(request.raw,response,path)
          if (!served) throw authError(404)
          reply.hijack()
        },
      })
      if (nativeSheets) app.route({
        method: ['GET','HEAD'], url: '/native-xlsx/*',
        onRequest: async (request,reply) => {
          reply.raw.setHeader('Cache-Control','private, no-store')
          reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${nativeConnectSources}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
          await sessions.authenticate(cookies(request).session ?? '')
        },
        handler: async (request,reply) => {
          const url = new URL(request.url,config.origin), path = url.pathname.slice('/native-xlsx'.length)
          if (path === '/' || path === '/index.html') {
            const opened = await files.openFile(cookies(request).session ?? '',url.searchParams.get('fileId') ?? '')
            if (opened.format !== 'xlsx') throw authError(404)
          }
          // No source fallback and no arbitrary file paths: only verified build assets.
          const response = reply.raw
          const served = await nativeSheets(request.raw,response,path)
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
  } catch(error) {
    // Includes asynchronous plugin/ready failures after private pipeline creation.
    // A dirty drain may reject; preserve the original startup failure, never force
    // close shared resources past that failure.
    await app.close().catch(()=>{})
    throw error
  }
}
