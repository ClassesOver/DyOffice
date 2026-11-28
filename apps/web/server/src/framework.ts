import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import { METHODS } from 'node:http'
import rateLimit from '@fastify/rate-limit'
import { randomUUID } from 'node:crypto'
import { sendJson } from '../http-response.mjs'
import { isAssistantErrorCode } from '../../../../packages/web-contracts/src/assistant-errors.ts'

declare module 'fastify' {
  interface FastifyContextConfig {
    workspaceAssetPrefix?: string
  }
}

function isWorkspaceAsset(request: FastifyRequest): boolean {
  const prefix = request.routeOptions.config.workspaceAssetPrefix
  return prefix !== undefined && new URL(request.url, 'http://localhost').pathname.startsWith(prefix)
}

function sendSafeError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const errorStatus = (error as { statusCode?: number } | null)?.statusCode
  const status = typeof errorStatus === 'number' && errorStatus >= 400 && errorStatus < 600
    ? errorStatus : 500
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value)
  }
  const retryAfter = (error as { retryAfter?: number } | null)?.retryAfter
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) reply.raw.setHeader('Retry-After', Math.ceil(retryAfter))
  reply.raw.setHeader('X-Request-ID', request.id)
  reply.raw.setHeader('Referrer-Policy', 'no-referrer')
  reply.hijack()
  // A public classification (assistant-errors.ts) may accompany the generic
  // text so clients can act on it; the original message never does.
  const code = (error as { code?: unknown } | null)?.code
  sendJson(reply.raw, status, { error: status >= 500 ? '服务暂时不可用' : '请求无效', ...(isAssistantErrorCode(code) ? { code } : {}) })
}


export async function createApiShell(limits?: { max: number; timeWindow: number }) {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
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
  const apiMax = limits?.max ?? 600
  // An editor loads many build resources per document. Give those resources a
  // separate bounded budget so they cannot exhaust the quota for opening files.
  await app.register(rateLimit, {
    global: true,
    max: request => isWorkspaceAsset(request) ? apiMax * 4 : apiMax,
    timeWindow: limits?.timeWindow ?? 60_000,
    keyGenerator: request => isWorkspaceAsset(request) ? request.ip + ':workspace-assets' : request.ip,
  })
  return app
}
