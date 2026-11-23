import type { AssistantSourceMode } from '../../../../packages/web-contracts/src/assistant.ts'
import {createKnowledgeService} from './modules/knowledge/service.ts'
import {registerKnowledgeRoutes} from './modules/knowledge/routes.ts'
import {createAssistantBackgroundRunner} from './modules/assistant-channel/background-runner.ts'
import {createAssistantBackgroundStore} from './modules/assistant-channel/background-store.ts'
import {registerAssistantSourceCatalog} from './modules/sources/assistant-catalog.ts'
import {createCodingModelBridge} from './modules/coding/model-bridge.ts'
import {createCodingHarness} from './modules/coding/harness.ts'
import {createHarnessRegistry, type HarnessAdapter} from './modules/coding/registry.ts'
import {registerTaskEventRoutes} from './modules/tasks/routes.ts'
import {registerCodingRoutes} from './modules/coding/routes.ts'
import {createCodingTaskRecoveryStore} from './modules/coding/task-recovery-store.ts'
import {registerProbeAssets} from './modules/providers/probe-assets.ts'
import {createSkillService} from './modules/skills/service.ts'
import {registerSkillRoutes} from './modules/skills/routes.ts'
import {registerSharedProviderGateway} from './modules/providers/shared-gateway.ts'
import {registerAssistantAttachmentRoutes} from './modules/providers/attachments.ts'
import {createAiSearchService} from './modules/ai-tools/search-service.ts'
import {registerAiSearchRoutes} from './modules/ai-tools/routes.ts'
import {createAiMediaService} from './modules/ai-tools/media-service.ts'
import {registerAiMediaRoutes} from './modules/ai-tools/media-routes.ts'
import {createStyleTemplateService} from './modules/style-templates/service.ts'
import {registerStyleTemplateRoutes} from './modules/style-templates/routes.ts'
import {registerPersonalProviderGateway} from './modules/providers/gateway.ts'
import { registerFixedProviderProbe } from './modules/providers/fixed-probe.ts'
import type { AdminPipelineProfile } from './modules/providers/admin-pipeline.ts'
import { registerAdminSyntheticProbe } from './modules/providers/synthetic-probe.ts'
import { createSheetsSaveService, type SheetsPlanner, type SheetsWorkbookPlanner, type SheetsSaveNative } from './modules/sheets/save.ts'
import { createSheetsService, type SheetsNative, type SheetsPackageReader } from './modules/sheets/service.ts'
import { registerSheetsRoutes } from './modules/sheets/routes.ts'
import { createSlidesSaveService } from './modules/slides/save.ts'
import { createSlidesService, type SlidesSessionHost } from './modules/slides/service.ts'
import { registerSlidesRoutes } from './modules/slides/routes.ts'
import { createReadinessProbe } from './readiness.ts'
import { createStaticAssets, createRefreshableStaticAssets } from '../static-assets.mjs'
import { dshEmbedOrigin, registerLocalShell } from './local-shell.ts'
import type { FastifyInstance, HTTPMethods } from 'fastify'
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
import { createCsrfService, cookies, assertHttpDevelopmentMode } from './modules/auth/csrf.ts'
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
import {createAssistantChannelService} from './modules/assistant-channel/service.ts'
import {registerAssistantChannelRoutes} from './modules/assistant-channel/routes.ts'
import {createHarnessDataAccess} from './modules/coding/data-access.ts'
import {registerHarnessDataRoutes,registerAnalysisDeliveryRoutes} from './modules/coding/data-routes.ts'
import {createHarnessDataMailbox} from './modules/coding/data-mailbox.ts'
import {createHarnessArtifacts} from './modules/coding/artifacts.ts'
import { registerWorkspaceSourceToolRoutes } from './modules/sources/tool-routes.ts'
import type { SourceEgressTarget } from './security/egress.ts'
import { createPdfService } from './modules/pdf/service.ts'
import { registerPdfRoutes } from './modules/pdf/routes.ts'
import { registerMcpRoutes } from './modules/mcp-server/routes.ts'

export interface LocalWebConfig {
  rateLimit?: { max: number; windowMs: number };
  db: IdentityStore; businessPool?: Pool; deploymentId: string; origin: string; csrfKey: string; insecureHttpDev?: boolean; passwords?: PasswordService;
  objectStore?: ObjectStore; filePolicy?: FilePolicy; nativeDocsDirectory?: string; nativeSheetsDirectory?: string; nativeSlidesDirectory?: string; slidesHost?: SlidesSessionHost; nativePdf?: boolean; nativePdfDirectory?: string; nativeJobs?: boolean; sheetsNative?: SheetsNative & Partial<SheetsSaveNative>; sheetsPlanner?: SheetsPlanner; sheetsWorkbookPlanner?: SheetsWorkbookPlanner; sheetsPackageReader?: SheetsPackageReader; localShellDirectory?: string; dshEditorOrigin?: string;
  globalConfigKeyring?: SecretKeyring;
  sourcesCredentialKeys?: string;
  sourcesEgressTargets?: readonly SourceEgressTarget[];
  /** Trusted assistant composition; never model-supplied credentials or scope. */
  assistantSourceCatalog?: boolean;
  assistantSourceMode?: AssistantSourceMode;
  onSourceToolsReady?: (tools: WorkspaceSourceTools) => void;
  adminAiSyntheticProbe?: boolean;
  // Explicit network-capable fixed probe, NOT the offline diagnostic. No automatic run.
  adminProviderProbeDirectory?: string;
  adminProviderProbe?: { profiles: readonly AdminPipelineProfile[] };
  providerGateway?: { profiles: readonly AdminPipelineProfile[] } | {mode:'shared'};
  /** Optional peer adapters are trusted server composition, never browser supplied. */
  assistantChannels?: boolean;
  assistantBackground?: {pool:Pool};
  codingHarnesses?: false | {adapters?: readonly HarnessAdapter[]; defaultId?: string; cliPath?: string; analysisPython?: string};
  providerShutdownTimeoutMs?: number;
  /** Notification polling/heartbeat timing; saves remain on the HTTP file API. */
  realtime?: RealtimeOptions;
  /** Explicit trusted composition; no HTTP route can supply policy or dispatch. */
  realtimeCommands?: RealtimeCommandPolicy;
  onRealtimeReady?: (server: RealtimeServer) => void;
  wordCollaboration?: boolean;
  passwordBlocklistFile?: string; loginLimits?: LoginLimits; idleMs?: number; absoluteMs?: number; closeDb?: () => Promise<void>
}
export async function buildLocalApp(config: LocalWebConfig): Promise<FastifyInstance> {
  assertHttpDevelopmentMode(config.insecureHttpDev, config.origin)
  if (process.env.NODE_ENV === 'production') throw new Error('Local runtime is not allowed in production before enterprise release gates')
  if (config.adminAiSyntheticProbe !== undefined && typeof config.adminAiSyntheticProbe !== 'boolean') throw new Error('Invalid synthetic probe configuration')
  if (config.adminAiSyntheticProbe && !config.businessPool) throw new Error('Synthetic probe requires restricted business pool')
  if (config.providerShutdownTimeoutMs !== undefined && (!Number.isSafeInteger(config.providerShutdownTimeoutMs) || config.providerShutdownTimeoutMs < 1 || config.providerShutdownTimeoutMs > 35_000)) throw new Error('Invalid provider shutdown timeout')
  if (config.adminProviderProbe !== undefined && (!config.adminProviderProbe || Object.keys(config.adminProviderProbe).join() !== 'profiles' || !Array.isArray(config.adminProviderProbe.profiles) || !config.adminProviderProbe.profiles.length || !config.businessPool || !config.globalConfigKeyring || config.adminProviderProbe.profiles.some(p=>!p || p.deploymentId!==config.deploymentId))) throw new Error('Invalid provider probe configuration')
  if(config.adminProviderProbeDirectory!==undefined && (!config.adminProviderProbe || typeof config.adminProviderProbeDirectory!=='string' || !config.adminProviderProbeDirectory))throw new Error('Probe assets require explicit local probe')
  const assistantSourceMode = config.assistantSourceMode ?? (config.assistantSourceCatalog ? 'metadata-only' : 'off')
  if (!['off','metadata-only','read-only-analysis'].includes(assistantSourceMode) || assistantSourceMode !== 'off' && !config.providerGateway) throw new Error('Assistant source mode requires provider gateway')
  if (assistantSourceMode === 'read-only-analysis' && !config.sourcesCredentialKeys) throw new Error('Assistant source analysis requires source credential keys')
  if(config.assistantSourceCatalog!==undefined && (typeof config.assistantSourceCatalog!=='boolean' || config.assistantSourceCatalog && !config.providerGateway)) throw new Error('Assistant source catalog requires provider gateway')
  if(config.assistantChannels!==undefined&&typeof config.assistantChannels!=='boolean')throw Error('Invalid assistant channel configuration')
  if(config.providerGateway!==undefined && (!config.providerGateway || !config.businessPool || !config.globalConfigKeyring || ('mode' in config.providerGateway ? config.providerGateway.mode!=='shared'||Object.keys(config.providerGateway).join()!=='mode' : Object.keys(config.providerGateway).join()!=='profiles'||!Array.isArray(config.providerGateway.profiles))))throw new Error('Provider gateway requires restricted pool and keyring')
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
  if (config.nativeSlidesDirectory && typeof config.slidesHost?.openSession !== 'function') throw new Error('Native slides require a session host')
  if (config.nativePdfDirectory && !config.objectStore) throw new Error('Native PDF requires File API')
  if (config.slidesHost && !config.objectStore) throw new Error('Native slides sessions require File API')
  // The four native editor bundles are independent; load their asset inventories concurrently.
  const nativeEditorAssets = (assetDirectory: string | undefined) => assetDirectory ? createRefreshableStaticAssets({assetMode:'built',assetDirectory,pages:['index.html'],assetInventory:'.vite/native-assets.json',cacheControl:'private, no-store'}) : undefined
  const [nativeSheets, nativeSlides, nativePdf, nativeDocs] = await Promise.all([config.nativeSheetsDirectory, config.nativeSlidesDirectory, config.nativePdfDirectory, config.nativeDocsDirectory].map(nativeEditorAssets))
  const passwords = config.passwords ?? await createPasswordService({ blockedPasswords: await loadPasswordBlocklist(config.passwordBlocklistFile) })
  const accounts = createAccountService({ db: config.db, passwords, deploymentId: config.deploymentId })
  const csrf = createCsrfService({ db: config.db, deploymentId: config.deploymentId, origin: config.origin, key: config.csrfKey, insecureHttpDev: config.insecureHttpDev })
  const sessions = createSessionService({ db: config.db, accounts, deploymentId: config.deploymentId, idleMs: config.idleMs, absoluteMs: config.absoluteMs, credentials: csrf.sessionCredentials })
  // Explicit same-origin WS source is required by browsers that do not include
  // wss in connect-src 'self'. Never grant the unrestricted wss: scheme.
  const realtimeSource = new URL(config.origin)
  realtimeSource.protocol = realtimeSource.protocol === 'https:' ? 'wss:' : 'ws:'
  const nativeConnectSources = `'self' blob: ${realtimeSource.origin}`
  const throttle = createLoginThrottle(config.db, config.deploymentId, config.csrfKey, config.loginLimits)
  const app = await createApiShell(config.rateLimit?{max:config.rateLimit.max,timeWindow:config.rateLimit.windowMs}:undefined)
  try {
  app.addHook('onRequest', async request => { csrf.bindRequest(request) })
  const dshEditorOrigin=config.localShellDirectory?dshEmbedOrigin(config.dshEditorOrigin):undefined
  if(dshEditorOrigin===config.origin)throw new Error('DSH editor embed requires a separate origin')
  const nativeAncestors=(target:string)=>{
    const url=new URL(target,config.origin)
    return dshEditorOrigin&&(url.pathname.endsWith('/')||url.pathname.endsWith('/index.html'))&&url.searchParams.get('dshEmbed')==='1'
      ? "'self' "+dshEditorOrigin : "'self'"
  }
  if (config.localShellDirectory) await registerLocalShell(app,config.localShellDirectory,dshEditorOrigin)
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
    const transactions = createPrincipalTransactions({ pool: config.businessPool, deploymentId: config.deploymentId, idleMs: config.idleMs, sessionCredentials: csrf.sessionCredentials })
    const sources = createSourceService({ transactions, credentialKeys: config.sourcesCredentialKeys, egressTargets: config.sourcesEgressTargets })
    const sourceResults = createWorkspaceSourceResults({ transactions })
    const sourceTools = createWorkspaceSourceTools({ sources, results: sourceResults })
    if(config.assistantBackground&&(!config.assistantChannels||!config.objectStore||!config.providerGateway))throw Error('Background execution requires channels, object storage and model gateway')
    const assistantChannels=config.assistantChannels===true?createAssistantChannelService({transactions,credentialKey:config.csrfKey,backgroundEnabled:!!config.assistantBackground}):undefined
    const artifacts=config.objectStore?createHarnessArtifacts({transactions,objects:config.objectStore}):undefined
    const harnessData=createHarnessDataAccess({tools:sourceTools,results:sourceResults,sessions,artifacts})
    // Lazy runtime: registering Codex neither resolves its executable nor starts a process.
    const codingConfig = config.codingHarnesses === false ? undefined : config.codingHarnesses ?? {}
    let officeGateway: ReturnType<typeof registerPersonalProviderGateway> | ReturnType<typeof registerSharedProviderGateway> | undefined
    const codingRuntime=createCodingHarness({cliPath:codingConfig?.cliPath,analysisPython:codingConfig?.analysisPython})
    const harnesses = config.providerGateway && codingConfig ? createHarnessRegistry([
      {descriptor: {id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding']},async run(input,signal,context){
        if(!context?.openModel)throw Error('Office model unavailable')
        const bridge=await context.openModel()
        let mailbox:Awaited<ReturnType<typeof createHarnessDataMailbox>>|undefined
        try{
          mailbox=context.data?await createHarnessDataMailbox(app,context.data.grant.taskId):undefined
          return await codingRuntime.run(input,signal,bridge,context.data?{...context.data,mailboxDirectory:mailbox!.directory}:undefined,context.onProgress)
        } finally{try{await mailbox?.close()}finally{await bridge.close()}}
      }},
      ...(codingConfig.adapters ?? []),
    ], codingConfig.defaultId ?? 'codex') : undefined
    const files = config.objectStore ? createFileService({ transactions, objects: config.objectStore, ...config.filePolicy, capabilities: nativeDocs || nativeSheets || nativeSlides || nativePdf ? { docx: nativeDocs ? 'editable' : 'unsupported',xlsx: nativeSheets ? 'editable' : 'unsupported',pptx: nativeSlides ? 'editable' : 'unsupported',pdf: nativePdf ? 'editable' : 'unsupported',...(nativePdf?{pdfEditor:'editable' as const}:{}) } : undefined }) : undefined
    if(assistantChannels)registerAssistantChannelRoutes(app,assistantChannels,csrf,{data:harnessData,baseUrl:config.origin+'/api/v1/agents'},config.objectStore,files,dshEditorOrigin)
    if(harnesses||assistantChannels){
      registerHarnessDataRoutes(app,harnessData)
      if(artifacts)registerAnalysisDeliveryRoutes(app,artifacts,csrf)
    }
    const codingRoutes=harnesses?registerCodingRoutes(app,{registry:harnesses,sessions,csrf,data:harnessData,dataBaseUrl:config.origin+'/api/v1/agents',
        authorizeDocument:files?(token,documentId)=>files.openFile(token,documentId):undefined,
        recoveryStore:files?createCodingTaskRecoveryStore(transactions):undefined,
        async openModel(token,modelId,signal,onProgress){
          if(!officeGateway?.codingTurns)throw Error('Office model unavailable')
          const bridge=await createCodingModelBridge({token,modelId,signal,turns:officeGateway.codingTurns,...(onProgress?{onProgress}:{})})
          return {...bridge,modelId}
        }}):undefined
    if(codingRoutes?.events||assistantChannels)registerTaskEventRoutes(app,csrf,codingRoutes?.events,assistantChannels?.ownerEventPage)
    const admitContinuation=codingRoutes?.admitContinuation
    if(config.providerGateway && 'mode' in config.providerGateway)ownedProbes.push(officeGateway=registerSharedProviderGateway(app,{transactions,sessions,csrf,keyring:config.globalConfigKeyring!,harnesses,sourceMode:assistantSourceMode,assistantChannels:config.assistantChannels,admitContinuation}))
    else if(config.providerGateway)ownedProbes.push(officeGateway=registerPersonalProviderGateway(app,{transactions,sessions,csrf,deploymentId:config.deploymentId,keyring:config.globalConfigKeyring!,profiles:config.providerGateway.profiles,harnesses,sourceMode:assistantSourceMode,assistantChannels:config.assistantChannels,admitContinuation}))
    else app.get('/api/v1/ai/catalog',async(request,reply)=>{reply.header('Cache-Control','private, no-store');await sessions.authenticate(cookies(request).session??'');return {entries:[],defaultId:null}})
    if(config.assistantBackground&&assistantChannels&&config.objectStore&&officeGateway){
      await assertRuntimePool(config.assistantBackground.pool,'worker')
      await assertSharedDatabase(config.db.pool,config.assistantBackground.pool)
      const runner=createAssistantBackgroundRunner({store:createAssistantBackgroundStore({pool:config.assistantBackground.pool,deploymentId:config.deploymentId}),service:assistantChannels,objects:config.objectStore,answer:officeGateway.backgroundAnswer})
      ownedProbes.push(runner)
      app.addHook('onReady',async()=>{runner.start()})
    }
    if (config.adminAiSyntheticProbe === true) ownedProbes.push(registerAdminSyntheticProbe(app, { transactions, sessions, csrf }))
    if(config.adminProviderProbe){
      try{const probe=registerFixedProviderProbe(app,{deploymentId:config.deploymentId,transactions,sessions,csrf,keyring:config.globalConfigKeyring!,profiles:config.adminProviderProbe.profiles});ownedProbes.push(probe);if(probeAssets)registerProbeAssets(app,probeAssets,probe.authorize)}
      catch(error){await app.close();throw error}
    }
    registerSourceRoutes(app, sources, sessions, csrf)
    registerWorkspaceSourceToolRoutes(app, { tools: sourceTools, results: sourceResults, sessions, csrf })
    config.onSourceToolsReady?.(sourceTools)
    if (assistantSourceMode !== 'off') registerAssistantSourceCatalog(app, {sessions,csrf,sources, analysis: assistantSourceMode === 'read-only-analysis' ? sourceTools : undefined})
    registerPreferenceRoutes(app, createPreferenceService(transactions), sessions, csrf)
    registerSkillRoutes(app, createSkillService(transactions), sessions, csrf)
    registerWorkspaceRoutes(app, createWorkspaceService(transactions), sessions, csrf)
    const convertMergeSource=config.sheetsNative?.convertMergeSource
    registerAssistantAttachmentRoutes(app,{sessions,csrf,convertLegacyWorkbook:convertMergeSource&&((bytes,signal)=>convertMergeSource(bytes,'xls',signal))})
    registerAiSearchRoutes(app,{service:createAiSearchService({transactions,keyring:config.globalConfigKeyring}),sessions,csrf})
    registerAiMediaRoutes(app,{service:createAiMediaService({transactions,keyring:config.globalConfigKeyring}),sessions,csrf})
    registerStyleTemplateRoutes(app,createStyleTemplateService(transactions),sessions,csrf)
    registerGlobalConfigRoutes(app, createGlobalConfigService({transactions, keyring: config.globalConfigKeyring}), sessions, csrf)
    if (config.objectStore && files) {
      const leases = createLeaseService({ transactions, assertOfficeWritable:files.assertOfficeWritable })
      const revisions = createRevisionService({ transactions, objects: config.objectStore, files, ...config.filePolicy })
      registerFileRoutes(app,files,sessions,csrf,{ leases, revisions, wordCollaboration:config.wordCollaboration })
      registerMcpRoutes(app,transactions,files,csrf,config.objectStore,config.filePolicy,
        config.sheetsPlanner && config.sheetsWorkbookPlanner && config.sheetsNative?.savePlan ? {
          native: config.sheetsNative as SheetsSaveNative,
          plan: config.sheetsPlanner, planFromWorkbook: config.sheetsWorkbookPlanner,
        } : undefined, config.slidesHost)
      registerKnowledgeRoutes(app,createKnowledgeService({transactions,files}),sessions,csrf)
      registerPdfRoutes(app,createPdfService({ files, leases, revisions }),sessions,csrf)
      // T17 notification/reconciliation only; preClose terminates upgraded
      // sockets before HTTP shutdown waits on their lifetime.
      const realtime = registerRealtimeRoutes(app,{ transactions,sessions,csrf,origin: config.origin,options: config.realtime,commandPolicy: config.realtimeCommands,channelNotifications:assistantChannels?(token,fileId)=>assistantChannels.notifications(token,fileId):undefined })
      config.onRealtimeReady?.(realtime)
      if (config.realtimeCommands) registerCommandRoutes(app, { sessions,csrf,
        createRequestCommands: createCommandRequestFactory(transactions, config.realtimeCommands.lookupTool) })
      if (config.sheetsNative) {
        const saves = config.sheetsPlanner ? createSheetsSaveService({files,leases,revisions,native:config.sheetsNative as SheetsNative & SheetsSaveNative,plan:config.sheetsPlanner,planFromWorkbook:config.sheetsWorkbookPlanner}) : undefined
        registerSheetsRoutes(app,createSheetsService({files,native:config.sheetsNative,readPackage:config.sheetsPackageReader}),sessions,csrf,saves)
      }
      if (config.slidesHost) {
        const slides = createSlidesService({files,leases,revisions,host:config.slidesHost})
        app.addHook('onClose', () => slides.dispose())
        registerSlidesRoutes(app,slides,sessions,csrf,createSlidesSaveService({files,leases,revisions,sessions:slides}))
      }
      if (config.nativeJobs) registerJobRoutes(app,createJobService({ transactions,enabledTypes: ['xlsx.roundtrip'] }),sessions,csrf)
      if (nativeDocs) app.route({
        method: ['GET','HEAD'], url: '/native-docx/*',
        onRequest: async (request,reply) => {
          reply.raw.setHeader('Cache-Control','private, no-store')
          reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${nativeConnectSources}; object-src 'none'; base-uri 'none'; frame-ancestors ${nativeAncestors(request.url)}`)
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
      if (nativePdf) app.route({
        method: ['GET','HEAD'], url: '/native-pdf/*',
        onRequest: async (request,reply) => {
          reply.raw.setHeader('Cache-Control','private, no-store')
          reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${nativeConnectSources}; object-src 'none'; base-uri 'none'; frame-ancestors ${nativeAncestors(request.url)}`)
          await sessions.authenticate(cookies(request).session ?? '')
        },
        handler: async (request,reply) => {
          const url = new URL(request.url,config.origin), path = url.pathname.slice('/native-pdf'.length)
          if (path === '/' || path === '/index.html') {
            const opened = await files.openFile(cookies(request).session ?? '',url.searchParams.get('fileId') ?? '')
            if (opened.format !== 'pdf') throw authError(404)
          }
          if (!await nativePdf(request.raw,reply.raw,path)) throw authError(404)
          reply.hijack()
        },
      })
      if (nativeSlides) app.route({
        method: ['GET','HEAD'], url: '/native-pptx/*',
        onRequest: async (request,reply) => {
          reply.raw.setHeader('Cache-Control','private, no-store')
          // 'wasm-unsafe-eval' keeps harfbuzzjs font shaping working; media-src covers
          // PPTX-embedded audio/video played through the slides renderer.
          reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${nativeConnectSources}; object-src 'none'; base-uri 'none'; frame-ancestors ${nativeAncestors(request.url)}`)
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
          reply.raw.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${nativeConnectSources}; object-src 'none'; base-uri 'none'; frame-ancestors ${nativeAncestors(request.url)}`)
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
