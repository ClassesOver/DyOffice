import type {FastifyInstance} from 'fastify'
import type {SessionService} from '../auth/sessions.ts'
import {cookies, type createCsrfService} from '../auth/csrf.ts'
import {ASSISTANT_ANALYSIS_OPERATIONS} from '../../../../../../packages/web-contracts/src/assistant.ts'
import type {WorkspaceSourceTools} from './tools.ts'
import {object,sourceError} from './config.ts'
import type {SourceService} from './service.ts'

/** Assistant routes are mounted only for the explicitly configured source mode. */
export function registerAssistantSourceCatalog(app: FastifyInstance, {sessions, csrf, sources, analysis}: {
  sessions: SessionService; csrf: ReturnType<typeof createCsrfService>; sources: Pick<SourceService, 'listSavedMetadata'>; analysis?: WorkspaceSourceTools
}) {
  if (analysis) for (const path of ['/api/v1/ai/sources/execute','/api/v1/files/:documentId/ai/sources/execute']) app.post(path, {
    bodyLimit: 40_000,
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    },
  }, request => {
    const call = object(request.body, ['name','arguments'])
    if (!ASSISTANT_ANALYSIS_OPERATIONS.some(name => name === call.name)) throw sourceError(403)
    return analysis.execute(cookies(request).session ?? '', call, (request.params as {documentId?:string}).documentId)
  })
  app.post('/api/v1/ai/sources/list', {
    bodyLimit: 1024,
    schema: {querystring: {type: 'object', additionalProperties: false, properties: {}}, body: {type: 'object', additionalProperties: false, properties: {after: {type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'}}}},
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    },
  }, request => sources.listSavedMetadata(cookies(request).session ?? '', request.body))
}
