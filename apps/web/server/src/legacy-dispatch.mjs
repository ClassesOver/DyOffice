import { randomUUID } from 'node:crypto'
import { authorizeDevApi } from '../request-boundary.mjs'
import { serveHealth } from '../health.mjs'
import { sendJson } from '../http-response.mjs'
import { handleAdmin } from './modules/admin/routes.mjs'
import { handleDocuments } from './modules/documents/routes.mjs'
import { handleFiles } from './modules/files/routes.mjs'
import { handleObjects } from './modules/objects/routes.mjs'
import { handlePage } from './modules/pages/routes.mjs'
import { handlePreferences } from './modules/preferences/routes.mjs'
import { handleSources } from './modules/sources/routes.mjs'

const ROUTES = [
  '/api/v1/health/live',
  '/api/v1/health/ready',
  '/api/v1/capabilities',
  '/api/preferences',
  '/api/models',
  '/api/admin/config',
  '/api/sources',
  '/api/files',
]

export async function dispatchLegacy(req, res, ctx) {
  res.setHeader('X-Request-ID', randomUUID())
  const send = (value, status = 200) => sendJson(res, status, value)
  try {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const tools = { url, path, send }
    if (await handlePage(req, res, ctx, tools)) return
    if (await serveHealth(req, res, { path, dataDirectory: ctx.directory, store: ctx.store })) return
    const access = authorizeDevApi(req, ctx.credentials, path)
    if ('status' in access) return send({ error: access.error }, access.status)
    const state = ctx.store.read()
    const scoped = { ...tools, state }
    if (await handleDocuments(req, res, ctx, scoped)) return
    if (await handlePreferences(req, res, ctx, scoped)) return
    if (await handleAdmin(req, res, ctx, scoped)) return
    if (await handleSources(req, res, ctx, scoped)) return
    if (await handleFiles(req, res, ctx, scoped)) return
    if (await handleObjects(req, res, ctx, scoped)) return
    send({ error: '接口不存在' }, 404)
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    const payload = { error: error.status ? error.message : '服务暂时不可用' }
    if (error.status && typeof error.publicCode === 'string') payload.code = error.publicCode
    send(payload, error.status || 500)
  }
}

export function registerLegacyRoutes(app, ctx) {
  const respond = async (request, reply) => {
    reply.hijack()
    await dispatchLegacy(request.raw, reply.raw, ctx)
  }
  for (const url of ROUTES) app.all(url, respond)
  app.all('/api/admin/mcp/:id/test', respond)
  app.all('/api/files/:id', respond)
  app.all('/api/v1/files/*', respond)
  app.all('/*', respond)
}
