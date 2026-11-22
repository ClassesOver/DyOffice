import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { WorkspaceSourceTools } from './tools.ts'
import type { createWorkspaceSourceResults } from './results.ts'
import { object, sourceError } from './config.ts'

export function registerWorkspaceSourceToolRoutes(app: FastifyInstance, { tools, results, sessions, csrf }: {
  tools: WorkspaceSourceTools; results: ReturnType<typeof createWorkspaceSourceResults>; sessions: SessionService; csrf: ReturnType<typeof createCsrfService>
}) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, request.method !== 'GET')
      if (request.method !== 'GET') csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })
    api.get('/api/v1/workspace/source-tools', async () => ({ tools: tools.definitions }))
    api.post('/api/v1/workspace/source-tools/execute', { bodyLimit: 40_000 }, request => tools.execute(cookies(request).session ?? '', request.body))
    api.get('/api/v1/workspace/data-results', request => {
      const query = object(request.query, ['after','limit'])
      if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(query.limit))) throw sourceError()
      return results.list(cookies(request).session ?? '', { ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) })
    })
    api.get('/api/v1/workspace/data-results/:id', request => {
      const query = object(request.query, ['offset','limit'])
      const number = (value: unknown) => { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(value)) throw sourceError(); return Number(value) }
      return results.read(cookies(request).session ?? '', { resultId: (request.params as {id: string}).id,
        ...(query.offset === undefined ? {} : { offset: number(query.offset) }), ...(query.limit === undefined ? {} : { limit: number(query.limit) }) })
    })
    api.delete('/api/v1/workspace/data-results/:id', async (request, reply) => {
      object(request.query, [])
      await results.remove(cookies(request).session ?? '', { resultId: (request.params as {id: string}).id })
      return reply.code(204).send()
    })
    api.get('/api/v1/workspace/data-results/:id/content', async (request, reply) => {
      object(request.query, [])
      const output = await results.download(cookies(request).session ?? '', (request.params as {id: string}).id)
      const name = encodeURIComponent(output.name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
      return reply.header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="query-result.json"; filename*=UTF-8''${name}`)
        .header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header('X-Content-Type-Options', 'nosniff').send(output.bytes)
    })
  })
}
