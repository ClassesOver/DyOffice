import type { FastifyInstance, HTTPMethods } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'

type LegacyHandler = (request: IncomingMessage, response: ServerResponse, requestId: string) => Promise<unknown>

export function registerLegacyRoutes(app: FastifyInstance, handleRequest: LegacyHandler) {
  // Transfer ownership after onRequest policy hooks and before body parsing. The legacy handler owns
  // body limits, auth and errors; binary uploads must never pass through a JSON parser.
  app.route({
    method: app.supportedMethods as HTTPMethods[],
    url: '/*',
    preParsing: async (request, reply) => {
      reply.hijack()
      await handleRequest(request.raw, reply.raw, request.id)
    },
    handler: async () => { throw new Error('Legacy request ownership was not transferred') },
  })
}
