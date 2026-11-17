import type {FastifyInstance} from 'fastify'
import type {SessionService} from '../auth/sessions.ts'
import {cookies, type createCsrfService} from '../auth/csrf.ts'
import type {SourceService} from './service.ts'

/** Opt-in metadata-only endpoint. Never dispatch model-selected tool names. */
export function registerAssistantSourceCatalog(app: FastifyInstance, {sessions, csrf, sources}: {
  sessions: SessionService; csrf: ReturnType<typeof createCsrfService>; sources: Pick<SourceService, 'listPublishedMetadata'>
}) {
  app.post('/api/v1/ai/sources/list', {
    bodyLimit: 1024,
    schema: {querystring: {type: 'object', additionalProperties: false, properties: {}}, body: {type: 'object', additionalProperties: false, properties: {after: {type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'}}}},
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    },
  }, request => sources.listPublishedMetadata(cookies(request).session ?? '', request.body))
}
