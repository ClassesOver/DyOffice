import { randomUUID } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import Fastify from 'fastify'
import { authorizeDevApi } from '../request-boundary.mjs'
import { assertModularConfig } from './config.mjs'
import { devPrincipalFor, principalFromSession } from './modules/policy/principal.mjs'
import { rawBody } from './http-helpers.mjs'
import { registerLegacyRoutes } from './legacy-dispatch.mjs'
import { registerHealthRoutes } from './modules/health/routes.mjs'
import { problem, publicStatus } from './problem.mjs'
import { createFixedWindowLimiter } from './rate-limit.mjs'

const HEALTH = new Set(['/api/v1/health/live', '/api/v1/health/ready'])
const BODY_LIMIT = 1024 * 1024
const FILE_BODY_LIMIT = 50 * 1024 * 1024
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

function pathname(url) {
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}

function clientAddress(request) {
  return request.socket?.remoteAddress || request.raw?.socket?.remoteAddress || 'unaddressed'
}

function requestPath(url) {
  try { return new URL(url, 'http://localhost').pathname }
  catch { return pathname(url) }
}

function attachPrincipal(request, principal) {
  request.principal = principal
  request.raw.dyofficePrincipal = principal
}

function authProblem(status, error, requestId) {
  return {
    error,
    type: 'about:blank',
    title: STATUS_CODES[status] || 'Error',
    status,
    detail: error,
    requestId,
  }
}

/**
 * Versioned API shell. A legacy workspace context mounts the personal and
 * admin routes. Without that context, unmigrated API paths stay 501.
 */
export async function buildApp(input) {
  const config = assertModularConfig(input)
  const hit = createFixedWindowLimiter(config.rateLimit)
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: config.legacy ? FILE_BODY_LIMIT : BODY_LIMIT,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  })
  if (config.legacy) {
    app.removeAllContentTypeParsers()
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
      request.raw[rawBody] = body
      done(null, body)
    })
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id)
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    const path = requestPath(request.url)
    // Health probes and static pages are public and read-only. Refuse other
    // methods here, before the body parser buffers up to the file limit for an
    // unauthenticated caller.
    if ((HEALTH.has(path) || !path.startsWith('/api/')) && request.method !== 'GET' && request.method !== 'HEAD') {
      reply.header('Allow', 'GET, HEAD')
      return reply.code(405).type('application/json; charset=utf-8').send(problem(405, request.id))
    }
    if (HEALTH.has(path)) return undefined
    const limited = hit(clientAddress(request))
    if (limited) {
      reply.header('Retry-After', String(limited.retryAfter))
      return reply.code(429).type('application/json; charset=utf-8').send(problem(429, request.id))
    }
    // The body parser buffers up to the file limit. Check API credentials
    // first so an unauthenticated request never allocates that buffer.
    // Health probes and static pages stay public.
    if (!path.startsWith('/api/')) return undefined
    // A session authenticator, when configured, is the only API identity.
    // The development bearer remains the identity until that authenticator is mounted.
    if (config.auth) {
      let session
      try {
        session = await config.auth.authenticate(request.raw)
      } catch {
        return reply.code(503).type('application/json; charset=utf-8').send(authProblem(503, '服务暂时不可用', request.id))
      }
      const principal = principalFromSession(session)
      if (!principal) {
        return reply.code(401).type('application/json; charset=utf-8').send(authProblem(401, '请登录', request.id))
      }
      attachPrincipal(request, principal)
      return undefined
    }
    if (!config.legacy) return undefined
    const access = authorizeDevApi(request.raw, config.legacy.credentials, path)
    if ('status' in access) {
      return reply.code(access.status).type('application/json; charset=utf-8').send(authProblem(access.status, access.error, request.id))
    }
    const principal = devPrincipalFor(access.principal)
    if (!principal) {
      return reply.code(401).type('application/json; charset=utf-8').send(authProblem(401, '请登录', request.id))
    }
    attachPrincipal(request, principal)
    return undefined
  })

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return
    const status = publicStatus(error)
    reply.header('X-Request-ID', request.id)
    reply.header('Cache-Control', 'no-store')
    if (status === 405 && !reply.hasHeader('Allow')) reply.header('Allow', 'GET, HEAD')
    return reply.code(status).type('application/json; charset=utf-8').send(problem(status, request.id))
  })

  app.setNotFoundHandler((request, reply) => {
    const path = pathname(request.url)
    const allowed = METHODS.filter((method) => app.hasRoute({ method, url: path }))
    reply.header('X-Request-ID', request.id)
    reply.header('Cache-Control', 'no-store')
    if (allowed.length > 0) {
      reply.header('Allow', allowed.join(', '))
      return reply.code(405).type('application/json; charset=utf-8').send(problem(405, request.id))
    }
    const status = path.startsWith('/api/') ? 501 : 404
    return reply.code(status).type('application/json; charset=utf-8').send(problem(status, request.id))
  })

  if (config.legacy) registerLegacyRoutes(app, config.legacy)
  else registerHealthRoutes(app, { readyCheck: config.readyCheck })
  return app
}
