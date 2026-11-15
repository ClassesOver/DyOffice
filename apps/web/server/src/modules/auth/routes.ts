import type { FastifyInstance } from 'fastify'
import { authError, type SessionService } from './sessions.ts'
import { cookies, serializeCookie, SESSION_COOKIE, LOGIN_COOKIE, type createCsrfService } from './csrf.ts'
import type { createLoginThrottle } from './throttle.ts'

type Dependencies = { sessions: SessionService; csrf: ReturnType<typeof createCsrfService>; throttle: ReturnType<typeof createLoginThrottle> }
const loginSchema = { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 256 }, password: { type: 'string', maxLength: 1024 } } } as const
const passwordSchema = { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', maxLength: 1024 } } } as const
export function registerAuthRoutes(app: FastifyInstance, { sessions, csrf, throttle }: Dependencies) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store') })
  app.get('/api/v1/auth/csrf', async (request, reply) => {
    csrf.originCheck(request, false)
    const auth = cookies(request)
    if (auth.session) {
      try {
        await sessions.authenticate(auth.session)
        return { csrfToken: csrf.sessionToken(auth.session) }
      } catch (error) { if ((error as { statusCode?: number }).statusCode !== 401) throw error }
    }
    const challenge = await csrf.issueLogin()
    reply.header('Set-Cookie', [...(auth.session ? [serializeCookie(SESSION_COOKIE, '', 0)] : []), serializeCookie(LOGIN_COOKIE, challenge.token, 300)])
    return { csrfToken: challenge.csrfToken }
  })
  app.post<{ Body: { username: string; password: string } }>('/api/v1/auth/login', { schema: { body: loginSchema }, bodyLimit: 4096 }, async (request, reply) => {
    const auth = cookies(request)
    if (auth.session) throw authError(409)
    await csrf.consumeLogin(request, auth.login)
    const admission = await throttle.reserve(request.body.username, request.ip, { requestId: request.id })
    const signed = await sessions.login(request.body.username, request.body.password, { requestId: request.id, ...admission })
    reply.header('Set-Cookie', [serializeCookie(SESSION_COOKIE, signed.token), serializeCookie(LOGIN_COOKIE, '', 0)])
    return { user: signed.user, csrfToken: csrf.sessionToken(signed.token) }
  })
  app.get('/api/v1/auth/me', async request => {
    const principal = await sessions.authenticate(cookies(request).session ?? '')
    return { user: { id: principal.userId, username: principal.username, displayName: principal.displayName, roles: principal.roles } }
  })
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const auth = cookies(request)
    if (auth.session) {
      csrf.requireSession(request, auth.session)
      await sessions.logout(auth.session, { requestId: request.id })
    } else csrf.originCheck(request)
    reply.header('Set-Cookie', [serializeCookie(SESSION_COOKIE, '', 0), serializeCookie(LOGIN_COOKIE, '', 0)])
    return reply.code(204).send()
  })
  app.get('/api/v1/auth/sessions', async request => ({ sessions: await sessions.list(cookies(request).session ?? '') }))
  app.delete<{ Params: { id: string } }>('/api/v1/auth/sessions/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' } } } } }, async (request, reply) => {
    const token = cookies(request).session
    csrf.requireSession(request, token)
    const result = await sessions.revoke(token!, request.params.id, { requestId: request.id })
    if (result.self) reply.header('Set-Cookie', [serializeCookie(SESSION_COOKIE, '', 0)])
    return reply.code(204).send()
  })
  app.post<{ Body: { password: string } }>('/api/v1/auth/reauth', { schema: { body: passwordSchema }, bodyLimit: 4096 }, async (request, reply) => {
    const token = cookies(request).session
    csrf.requireSession(request, token)
    const principal = await sessions.authenticate(token!)
    const admission = await throttle.reserve(principal.username, request.ip, { requestId: request.id })
    const replacement = await sessions.reauthenticate(token!, request.body.password, { requestId: request.id, ...admission })
    reply.header('Set-Cookie', [serializeCookie(SESSION_COOKIE, replacement)])
    return { csrfToken: csrf.sessionToken(replacement) }
  })
}
