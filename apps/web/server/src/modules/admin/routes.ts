import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { authError } from '../auth/sessions.ts'
import { cookies, uniqueHeader, type createCsrfService } from '../auth/csrf.ts'
import type { GlobalConfigService } from './service.ts'
import { requireConfigRevision } from './service.ts'
import type { CheckGlobalConfigRequest, SaveGlobalConfigRequest } from '../../../../../../packages/web-contracts/src/settings.ts'

const emptyQuery = { type: 'object', additionalProperties: false, properties: {} } as const
const revision = { type: 'integer', minimum: 0, maximum: 2147483646 } as const
function expectedRevision(header: string | undefined, value: unknown): number {
  let fromHeader: number | undefined
  if (header !== undefined) {
    if (!/^"(?:0|[1-9][0-9]*)"$/.test(header)) throw authError(400)
    fromHeader = requireConfigRevision(Number(header.slice(1,-1)))
  }
  const fromBody = value === undefined ? undefined : requireConfigRevision(value)
  if (fromHeader !== undefined && fromBody !== undefined && fromHeader !== fromBody) throw authError(400)
  if (fromHeader === undefined && fromBody === undefined) throw authError(428)
  return fromHeader ?? fromBody!
}
export function registerGlobalConfigRoutes(app: FastifyInstance, settings: GlobalConfigService, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control','private, no-store'); reply.header('Vary','Cookie')
      const token = cookies(request).session ?? '', principal = await sessions.authenticate(token)
      if (request.url.startsWith('/api/v1/admin/') && !principal.roles.includes('config_admin')) throw authError(403)
      if (!['GET','HEAD'].includes(request.method)) csrf.requireSession(request, token)
    })
    api.get('/api/v1/settings/public', { schema: { querystring: emptyQuery } }, async (request, reply) => {
      const result = await settings.getPublicSettings(cookies(request).session ?? '')
      reply.header('ETag', '"' + result.revision + '"'); return result
    })
    api.get('/api/v1/admin/config', { schema: { querystring: emptyQuery } }, async (request, reply) => {
      const result = await settings.getAdminConfig(cookies(request).session ?? '')
      reply.header('ETag', '"' + result.revision + '"'); return result
    })
    api.put<{ Body: SaveGlobalConfigRequest }>('/api/v1/admin/config', { bodyLimit: 256*1024, schema: { querystring: emptyQuery, body: { type: 'object', additionalProperties: false, required: ['patch'], properties: { expectedRevision: revision, patch: { type: 'object' } } } } }, async (request, reply) => {
      const result = await settings.saveGlobalConfig(cookies(request).session ?? '', expectedRevision(uniqueHeader(request,'if-match'),request.body.expectedRevision),request.body.patch)
      reply.header('ETag', '"' + result.revision + '"'); return result
    })
    api.post<{ Body: CheckGlobalConfigRequest }>('/api/v1/admin/config/check', { bodyLimit: 4096, schema: { querystring: emptyQuery, body: { type: 'object', additionalProperties: false, properties: { expectedRevision: revision, entryId: { type: 'string', minLength: 1, maxLength: 100 } } } } }, request => settings.checkGlobalConfig(cookies(request).session ?? '', request.body))
    api.post<{ Body: { expectedRevision?: number } }>('/api/v1/admin/config/rotate-key', { bodyLimit: 4096, preValidation: async request => { if (request.body === undefined) request.body = {} }, schema: { querystring: emptyQuery, body: { type: 'object', additionalProperties: false, properties: { expectedRevision: revision } } } }, async (request, reply) => {
      const result = await settings.rotateKey(cookies(request).session ?? '', expectedRevision(uniqueHeader(request,'if-match'), request.body.expectedRevision))
      reply.header('ETag', '"' + result.revision + '"'); return result
    })
  })
}
