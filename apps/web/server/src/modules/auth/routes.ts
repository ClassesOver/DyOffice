import type { FastifyInstance } from 'fastify'
import { authError, type SessionService } from './sessions.ts'
import { cookies, serializeCookie, SESSION_COOKIE, LOGIN_COOKIE, type createCsrfService } from './csrf.ts'
import type { createLoginThrottle } from './throttle.ts'
import type { UserService } from '../admin/users/service.ts'

type Dependencies = { users: UserService; sessions: SessionService; csrf: ReturnType<typeof createCsrfService>; throttle: ReturnType<typeof createLoginThrottle> }
const loginSchema = { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 256 }, password: { type: 'string', maxLength: 1024 } } } as const
const passwordSchema = { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', maxLength: 1024 } } } as const
export function registerAuthRoutes(app: FastifyInstance, { sessions, csrf, throttle, users }: Dependencies) {
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
  app.get('/api/v1/auth/session-proof', async request => {
    csrf.originCheck(request, false)
    const token = cookies(request).session ?? ''
    await sessions.authenticate(token)
    return {csrfToken: csrf.sessionToken(token)}
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
  app.get<{Querystring: {limit?: string; after?: string}}>('/api/v1/auth/login-history', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {limit: {type: 'string', pattern: '^(?:[1-9]|1[0-9]|20)$'}, after: {type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'}} } } }, async request => {
    const token = cookies(request).session ?? ''
    return Object.keys(request.query).length ? sessions.loginHistoryPage(token, {limit: request.query.limit === undefined ? undefined : Number(request.query.limit), after: request.query.after}) : {events: await sessions.loginHistory(token)}
  })
  app.get('/api/v1/auth/sessions', async request => ({ sessions: await sessions.list(cookies(request).session ?? '') }))
  app.post('/api/v1/auth/sessions/revoke-others', {
    bodyLimit: 1024,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } },
  }, async (request, reply) => {
    if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length !== 0)) throw authError(400)
    const token = cookies(request).session
    csrf.requireSession(request, token)
    await sessions.revokeOthers(token!, { requestId: request.id })
    return reply.code(204).send()
  })
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
  app.post<{ Body: { token: string; purpose: 'activate' | 'reset'; password: string } }>('/api/v1/auth/password-action', {
    bodyLimit: 4096, config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['token', 'purpose', 'password'], properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, purpose: { type: 'string', enum: ['activate', 'reset'] }, password: { type: 'string', maxLength: 1024 } } } },
  }, async (request, reply) => {
    const auth = cookies(request)
    if (auth.session) throw authError(409)
    await csrf.consumeLogin(request, auth.login)
    const ownerId = await users.actionIdentity(request.body.token, request.body.purpose)
    const admission = await throttle.reserve(ownerId, request.ip, { requestId: request.id })
    await users.redeemAction(request.body.token, request.body.purpose, request.body.password, { requestId: request.id, ...admission })
    reply.header('Set-Cookie', [serializeCookie(LOGIN_COOKIE, '', 0)])
    return reply.code(204).send()
  })
  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/api/v1/auth/change-password', {
    bodyLimit: 4096, schema: { body: { type: 'object', additionalProperties: false, required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string', maxLength: 1024 }, newPassword: { type: 'string', maxLength: 1024 } } } },
  }, async (request, reply) => {
    const token = cookies(request).session
    csrf.requireSession(request, token)
    const principal = await sessions.authenticate(token!)
    const admission = await throttle.reserve(principal.username, request.ip, { requestId: request.id })
    const replacement = await users.changePassword(token!, request.body.currentPassword, request.body.newPassword, { requestId: request.id, ...admission })
    reply.header('Set-Cookie', [serializeCookie(SESSION_COOKIE, replacement)])
    return { csrfToken: csrf.sessionToken(replacement) }
  })

}
