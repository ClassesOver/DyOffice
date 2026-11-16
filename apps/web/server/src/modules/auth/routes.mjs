import { isIP } from 'node:net'
import { CLEAR_SESSION_COOKIE } from '../../../auth/session-core.mjs'
import { principalContext } from '../../../auth/principal.mjs'
import { AccountLifecycleError } from '../../../auth/account-lifecycle.mjs'
import { PasswordChangeError } from '../../../auth/password-change.mjs'
import { ReauthError } from '../../../auth/reauth.mjs'
import { SessionManagementError } from '../../../auth/self-session-management.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const STATUS = {
  INVALID_INPUT: 400,
  INVALID_ACTION: 400,
  INVALID_CURSOR: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  REAUTHENTICATION_REQUIRED: 401,
  FORBIDDEN: 403,
  SELF_ACTION_FORBIDDEN: 403,
  NOT_FOUND: 404,
  ACCOUNT_DISABLED: 409,
  CONFLICT: 409,
  AUTHENTICATION_CHANGED: 409,
  RATE_LIMITED: 429,
  LEASE_REVOKE_FAILED: 503,
  UNAVAILABLE: 503,
}

export function isLocalAuthPath(path) {
  return path === '/api/v1/auth/login' ||
    path === '/api/v1/auth/logout' ||
    path === '/api/v1/auth/me' ||
    path === '/api/v1/auth/csrf' ||
    path === '/api/v1/auth/reauth' ||
    path === '/api/v1/auth/change-password' ||
    path === '/api/v1/auth/password-action' ||
    path === '/api/v1/auth/sessions' ||
    path.startsWith('/api/v1/auth/sessions/') ||
    path === '/api/v1/admin/users' ||
    path.startsWith('/api/v1/admin/users/')
}

function view(request) {
  const raw = request.raw || {}
  return {
    headers: request.headers,
    headersDistinct: request.headersDistinct,
    rawHeaders: raw.rawHeaders,
    socket: raw.socket || request.socket,
    url: request.url,
    method: request.method,
  }
}

function originAllowed(request, trustedOrigin) {
  const origin = request.headers.origin
  return typeof origin === 'string' && origin === trustedOrigin
}

function fail(reply, error) {
  const code = error?.code
  const status = STATUS[code] || 503
  return reply.code(status).send({ error: STATUS[code] ? code : 'UNAVAILABLE' })
}

// Enforce this at Fastify body-reader time, including the legacy Buffer parser,
// rather than buffering the larger file-upload limit before jsonBody checks.
const AUTH_JSON_BYTES = 8192

function jsonBody(value, keys) {
  // Legacy mode installs a wildcard parser that yields a Buffer. Auth routes
  // still need an object, without changing that raw body for other routes.
  if (Buffer.isBuffer(value) || typeof value === 'string') {
    const bytes = Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value)
    if (bytes === 0) value = {}
    else {
      if (bytes > AUTH_JSON_BYTES) return null
      try { value = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value) }
      catch { return null }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) return null
  if (Object.keys(value).some(key => !keys.includes(key))) return null
  return value
}

export function registerLocalAuthRoutes(app, auth) {
  const { deploymentId, trustedOrigin, loginService, sessionService, csrfPolicy, accounts, passwordChange, sessions, reauth } = auth

  function guardWrite(request, reply) {
    if (!originAllowed(request, trustedOrigin)) {
      reply.code(403).send({ error: 'FORBIDDEN' })
      return false
    }
    return true
  }

  app.post('/api/v1/auth/login', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    const body = jsonBody(request.body, ['username', 'password'])
    const ip = request.ip
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' || !isIP(ip)) {
      return reply.code(400).send({ error: 'INVALID_INPUT' })
    }
    const result = await loginService.login({ username: body.username, password: body.password, ipAddress: ip })
    if (result?.ok === true) {
      reply.header('Set-Cookie', result.cookie)
      return { ok: true }
    }
    const status = result?.code === 'RATE_LIMITED' ? 429 : 401
    return reply.code(status).send({ error: status === 429 ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS' })
  })

  app.post('/api/v1/auth/logout', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    try {
      const principal = await sessionService.authenticate(view(request), { deploymentId })
      if (!principal) return reply.code(401).send({ error: 'UNAUTHORIZED' })
      if (csrfPolicy.verify(view(request), principal) !== true) return reply.code(403).send({ error: 'FORBIDDEN' })
      await sessionService.revoke(view(request), { deploymentId })
      reply.header('Set-Cookie', CLEAR_SESSION_COOKIE)
      return { ok: true }
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/api/v1/auth/me', async (request, reply) => {
    const principal = await sessionService.authenticate(view(request), { deploymentId })
    const context = principalContext(principal)
    if (!context) return reply.code(401).send({ error: 'UNAUTHORIZED' })
    return { userId: context.userId, roles: context.roles, sessionId: context.sessionId, expiresAt: principal.expiresAt }
  })

  app.get('/api/v1/auth/csrf', async (request, reply) => {
    const principal = await sessionService.authenticate(view(request), { deploymentId })
    if (!principalContext(principal)) return reply.code(401).send({ error: 'UNAUTHORIZED' })
    return { csrfToken: csrfPolicy.issue(principal) }
  })

  app.post('/api/v1/auth/reauth', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    const body = jsonBody(request.body, ['password'])
    if (!body) return reply.code(400).send({ error: 'INVALID_INPUT' })
    try {
      return await reauth.reauthenticate(view(request), body)
    } catch (error) {
      if (!(error instanceof ReauthError)) return fail(reply, error)
      return fail(reply, error)
    }
  })

  app.post('/api/v1/auth/change-password', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    const body = jsonBody(request.body, ['currentPassword', 'newPassword'])
    if (!body) return reply.code(400).send({ error: 'INVALID_INPUT' })
    try {
      const changed = await passwordChange.changePassword(view(request), body)
      if (typeof changed?.cookie !== 'string' || /[\r\n]/.test(changed.cookie)) {
        return reply.code(503).send({ error: 'UNAVAILABLE' })
      }
      reply.header('Set-Cookie', changed.cookie)
      return { ok: true }
    } catch (error) {
      if (!(error instanceof PasswordChangeError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.post('/api/v1/auth/password-action', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    const body = jsonBody(request.body, ['token', 'newPassword'])
    if (!body) return reply.code(400).send({ error: 'INVALID_INPUT' })
    try {
      const redeemed = await accounts.redeemPasswordAction(view(request), body)
      return { userId: redeemed.userId, requiresLogin: true }
    } catch (error) {
      if (!(error instanceof AccountLifecycleError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.get('/api/v1/auth/sessions', async (request, reply) => {
    const limit = request.query?.limit === undefined ? undefined : Number(request.query.limit)
    const before = request.query?.before
    try {
      return await sessions.list(view(request), { limit, ...(before === undefined ? {} : { before }) })
    } catch (error) {
      if (!(error instanceof SessionManagementError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.delete('/api/v1/auth/sessions/:id', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    if (!UUID.test(request.params.id || '')) return reply.code(400).send({ error: 'INVALID_INPUT' })
    try {
      const result = await sessions.revoke(view(request), { sessionId: request.params.id })
      if (result.currentRevoked) reply.header('Set-Cookie', CLEAR_SESSION_COOKIE)
      return reply.code(204).send()
    } catch (error) {
      if (!(error instanceof SessionManagementError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.post('/api/v1/auth/sessions/revoke-others', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    const extra = jsonBody(request.body ?? {}, [])
    if (request.body != null && request.body !== '' && extra == null) {
      return reply.code(400).send({ error: 'INVALID_INPUT' })
    }
    try {
      await sessions.revokeOthers(view(request), {})
      return reply.code(204).send()
    } catch (error) {
      if (!(error instanceof SessionManagementError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.get('/api/v1/admin/users', async (request, reply) => {
    const limit = request.query?.limit === undefined ? undefined : Number(request.query.limit)
    const username = request.query?.username
    const id = request.query?.id
    const input = { ...(limit === undefined ? {} : { limit }) }
    if (username !== undefined || id !== undefined) input.cursor = { username, id }
    try {
      return await accounts.listUsers(view(request), input)
    } catch (error) {
      if (!(error instanceof AccountLifecycleError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.post('/api/v1/admin/users', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    const body = jsonBody(request.body, ['username', 'displayName', 'adminPassword'])
    if (!body) return reply.code(400).send({ error: 'INVALID_INPUT' })
    try {
      return reply.code(201).send(await accounts.createAccount(view(request), body))
    } catch (error) {
      if (!(error instanceof AccountLifecycleError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.patch('/api/v1/admin/users/:id', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    if (!UUID.test(request.params.id || '')) return reply.code(400).send({ error: 'INVALID_INPUT' })
    const body = jsonBody(request.body, ['enabled', 'roles', 'adminPassword'])
    if (!body || typeof body.adminPassword !== 'string') {
      return reply.code(400).send({ error: 'INVALID_INPUT' })
    }
    const keys = Object.keys(body).filter(key => key !== 'adminPassword')
    if (keys.length !== 1 || (keys[0] !== 'enabled' && keys[0] !== 'roles')) {
      return reply.code(400).send({ error: 'INVALID_INPUT' })
    }
    try {
      if (keys[0] === 'enabled') {
        return await accounts.setAccountEnabled(view(request), {
          userId: request.params.id, enabled: body.enabled, adminPassword: body.adminPassword,
        })
      }
      return await accounts.setRoles(view(request), {
        userId: request.params.id, roles: body.roles, adminPassword: body.adminPassword,
      })
    } catch (error) {
      if (!(error instanceof AccountLifecycleError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })

  app.post('/api/v1/admin/users/:id/password-reset', { bodyLimit: AUTH_JSON_BYTES }, async (request, reply) => {
    if (!guardWrite(request, reply)) return undefined
    if (!UUID.test(request.params.id || '')) return reply.code(400).send({ error: 'INVALID_INPUT' })
    const body = jsonBody(request.body, ['adminPassword'])
    if (!body) return reply.code(400).send({ error: 'INVALID_INPUT' })
    try {
      return await accounts.issuePasswordReset(view(request), { userId: request.params.id, adminPassword: body.adminPassword })
    } catch (error) {
      if (!(error instanceof AccountLifecycleError)) return fail(reply, { code: 'UNAVAILABLE' })
      return fail(reply, error)
    }
  })
}
