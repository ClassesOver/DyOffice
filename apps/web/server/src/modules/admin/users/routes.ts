import type { FastifyInstance } from 'fastify'
import type { UserService } from './service.ts'
import type { createCsrfService } from '../../auth/csrf.ts'
import { cookies, serializeCookie, SESSION_COOKIE } from '../../auth/csrf.ts'

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } } as const
export function registerUserRoutes(app: FastifyInstance, users: UserService, csrf: ReturnType<typeof createCsrfService>) {
  app.get<{ Querystring: { limit?: string; after?: string } }>('/api/v1/admin/users', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^[0-9]{1,3}$' }, after: { type: 'string', pattern: uuidPattern } } } } }, async request => {
    return users.list(cookies(request).session ?? '', { limit: request.query.limit === undefined ? undefined : Number(request.query.limit), after: request.query.after })
  })
  app.post<{ Body: { username: string; displayName?: string } }>('/api/v1/admin/users', { bodyLimit: 4096, schema: { body: { type: 'object', additionalProperties: false, required: ['username'], properties: { username: { type: 'string', maxLength: 256 }, displayName: { type: 'string', maxLength: 200 } } } } }, async (request, reply) => {
    const token = cookies(request).session
    csrf.requireSession(request, token)
    const result = await users.create(token!, request.body, { requestId: request.id })
    return reply.code(201).send(result)
  })
  app.patch<{ Params: { id: string }; Body: { status?: 'active' | 'disabled'; roles?: string[] } }>('/api/v1/admin/users/:id', { bodyLimit: 4096, schema: { params, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { status: { type: 'string', enum: ['active', 'disabled'] }, roles: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: ['personal', 'config_admin', 'operator', 'auditor'] } } } } } }, async (request, reply) => {
    const token = cookies(request).session
    csrf.requireSession(request, token)
    const result = await users.update(token!, request.params.id, request.body, { requestId: request.id })
    if (result.selfInvalidated) reply.header('Set-Cookie', [serializeCookie(SESSION_COOKIE, '', 0)])
    return { user: result.user }
  })
  for (const kind of ['activation', 'password-reset'] as const) {
    app.post<{ Params: { id: string } }>(`/api/v1/admin/users/:id/${kind}`, { schema: { params } }, async request => {
      const token = cookies(request).session
      csrf.requireSession(request, token)
      return kind === 'activation' ? users.issueActivation(token!, request.params.id, { requestId: request.id }) : users.issueReset(token!, request.params.id, { requestId: request.id })
    })
  }
}
