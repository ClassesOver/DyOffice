import type { FastifyInstance } from 'fastify'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { SessionService } from '../auth/sessions.ts'
import type { SourceService } from './service.ts'
import { object, sourceError } from './config.ts'

/** All source writes/execution require the normal same-origin session + CSRF.
 * Request-supplied SQL/JSON never becomes a Fastify schema or executable callback.
 */
export function registerSourceRoutes(app: FastifyInstance, sources: SourceService, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>) {
  const base = '/api/v1/sources'
  for (const method of ['GET','POST','PUT','DELETE'] as const) {
    const paths = method === 'GET' ? [base, base + '/:sourceId'] : method === 'POST' ? [base, base + '/:sourceId/test', base + '/:sourceId/query', base + '/:sourceId/discover'] : [base + '/:sourceId']
    for (const url of paths) app.route({
      method, url, bodyLimit: url.endsWith('/query') ? 40_000 : 16_384,
      onRequest: async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store')
        const token = cookies(request).session ?? ''
        if (method !== 'GET') csrf.requireSession(request, token)
        await sessions.authenticate(token)
      },
      handler: async (request, reply) => {
        const token = cookies(request).session ?? '', id = (request.params as { sourceId?: string }).sourceId
        if (method !== 'GET' && Object.keys(request.query as object).length) throw sourceError()
        if (method === 'GET') {
          if (id) { object(request.query, []); return sources.detail(token, id) }
          return sources.list(token, request.query)
        }
        if (method === 'DELETE') { await sources.remove(token, id, request.body); return reply.code(204).send() }
        if (method === 'PUT') return sources.save(token, id, request.body)
        if (url === base) return reply.code(201).send(await sources.create(token, request.body))
        if (url.endsWith('/test')) { object(request.body ?? {}, []); return sources.test(token, id) }
        if (url.endsWith('/discover')) return sources.discover(token,id,request.body)
        return sources.querySource(token, id, request.body ?? {})
      },
    })
  }
}
