import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import { METHODS } from 'node:http'
import rateLimit from '@fastify/rate-limit'
import { randomUUID } from 'node:crypto'
import { createApplicationHandler } from '../application.mjs'
import { isStoreReady } from '../health.mjs'
import { sendJson } from '../http-response.mjs'
import type { WebConfig } from './config.ts'
import { registerHealthRoutes } from './modules/health/routes.ts'
import { registerLegacyRoutes } from './modules/legacy/routes.ts'

function sendSafeError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const errorStatus = (error as { statusCode?: number } | null)?.statusCode
  const status = typeof errorStatus === 'number' && errorStatus >= 400 && errorStatus < 500
    ? errorStatus : 500
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value)
  }
  reply.raw.setHeader('X-Request-ID', request.id)
  reply.raw.setHeader('Referrer-Policy', 'no-referrer')
  reply.hijack()
  sendJson(reply.raw, status, { error: status === 500 ? '服务暂时不可用' : '请求无效' })
}

export async function buildApp(config: WebConfig): Promise<FastifyInstance> {
  // Validate prototype credentials/production guard before any listener is created.
  const { handleRequest, store } = await createApplicationHandler(config)
  const app = Fastify({
    logger: false,
    frameworkErrors: sendSafeError,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    requestTimeout: 120_000,
    connectionTimeout: 120_000,
    return503OnClosing: true,
  })
  // Preserve safe rejection for every Node HTTP request method. CONNECT uses
  // Node's separate tunnel event and is not an application request route.
  for (const method of METHODS) {
    if (method !== 'CONNECT' && !app.supportedMethods.includes(method)) {
      app.addHttpMethod(method, { hasBody: true })
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.raw.setHeader('X-Request-ID', request.id)
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff')
    reply.raw.setHeader('Referrer-Policy', 'no-referrer')
  })
  app.setErrorHandler(sendSafeError)
  await app.register(rateLimit, {
    global: true, max: config.rateLimit?.max ?? 600, timeWindow: config.rateLimit?.timeWindow ?? 60_000,
    keyGenerator: request => request.ip,
  })
  registerHealthRoutes(app, () => isStoreReady(config.directory, store))
  registerLegacyRoutes(app, handleRequest)
  await app.ready()
  return app
}
