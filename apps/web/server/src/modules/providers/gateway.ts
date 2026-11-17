import type {FastifyInstance} from 'fastify'
import {createAdminProviderPipeline, type AdminPipelineProfile} from './admin-pipeline.ts'
import {registerProviderRoutes} from './routes.ts'
import {cookies} from '../auth/csrf.ts'
import {tokenHash, type SessionService} from '../auth/sessions.ts'
import type {createCsrfService} from '../auth/csrf.ts'
import type {PrincipalTransactions} from '../../db/context.ts'
import type {SecretKeyring} from '../admin/secrets.ts'
import {assistantReadTools} from '../../../../../../packages/web-contracts/src/assistant.ts'

/** Trusted bootstrap profiles pin egress; HTTP never accepts destinations/keys. */
export function registerPersonalProviderGateway(app: FastifyInstance, options: {
  transactions: PrincipalTransactions; sessions: SessionService; csrf: ReturnType<typeof createCsrfService>
  keyring: SecretKeyring; profiles: readonly AdminPipelineProfile[]; deploymentId: string; sourceCatalog?: boolean
}) {
  if (!options.profiles.length || options.profiles.length > 128 || options.profiles.some(p => !p || p.deploymentId !== options.deploymentId)
    || options.profiles.some(p => typeof p.entryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(p.entryId))
    || new Set(options.profiles.map(p => p.entryId)).size !== options.profiles.length) throw new Error('Invalid provider gateway profiles')
  const allowedTools = assistantReadTools(options.sourceCatalog === true)
  const profiles = options.profiles.map(p => ({...p, allowedIpv4: [...p.allowedIpv4]}))
  const pipeline = createAdminProviderPipeline({...options, profiles, audience: 'personal', personalSourceCatalog: options.sourceCatalog === true})
  app.addHook('preClose', async () => {pipeline.dispose()})
  registerProviderRoutes(app, {...options, turns: {
    cancel: pipeline.turns.cancel,
    async run(input, emit) {
      const request = input.request as {system: string; messages: unknown[]; tools: {name: string}[]}
      const tools = request.tools.filter(t => t && allowedTools.has(t.name))
      await pipeline.turns.run({...input, request: {...request, tools}}, async event => {
        if (event.type === 'tool_call' && !tools.some(t => t.name === event.name)) throw new Error('Unapproved assistant tool')
        await emit(event)
      })
    },
  }})
  app.get('/api/v1/ai/catalog', {schema: {querystring: {type: 'object', additionalProperties: false, properties: {}}}}, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const token = cookies(request).session ?? ''
    options.csrf.requireSessionRead(request, token)
    return options.transactions.withPrincipalTransaction({kind: 'session', token}, async (c, principal) => {
      if (!principal.roles.includes('personal')) return {entries: [], defaultId: null}
      await c.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)", [tokenHash(token), String(options.transactions.sessionIdleMs)])
      const {rows} = await c.query('SELECT * FROM personal_provider_catalog()')
      const available = rows.filter(e => profiles.some(p => p.entryId === e.id && p.revision === e.revision && p.providerId === e.provider_id && p.model === e.model && p.baseUrl === e.base_url))
      return {entries: available.map(({id, label, model}) => ({id, label, model})), defaultId: available.find(e => e.preferred)?.id ?? available[0]?.id ?? null, ...(options.sourceCatalog === true && available.length ? {sourceCatalog: true} : {})}
    })
  })
  return pipeline
}
