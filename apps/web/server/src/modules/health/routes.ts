import type { FastifyInstance, HTTPMethods } from 'fastify'

// Application-owned, static schemas; never derived from remote tools or user input.
const probeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['state'],
  properties: { state: { type: 'string', enum: ['alive', 'ready', 'unavailable'] } },
} as const

export function registerHealthRoutes(app: FastifyInstance, ready: () => Promise<boolean>) {
  const problemSchema = {
    type: 'object',
    properties: {
      error: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' },
      status: { type: 'integer' }, detail: { type: 'string' }, requestId: { type: 'string' },
    },
    required: ['error', 'type', 'title', 'status', 'detail', 'requestId'],
    additionalProperties: false,
  } as const
  for (const kind of ['live', 'ready'] as const) {
    app.route({
      method: app.supportedMethods as HTTPMethods[],
      url: `/api/v1/health/${kind}`,
      config: { rateLimit: false },
      schema: { response: { 200: probeSchema, 503: probeSchema, 405: problemSchema } },
      onRequest: async (_request, reply) => {
        reply.header('Cache-Control', 'no-store')
        if (_request.method !== 'GET' && _request.method !== 'HEAD') {
          return reply.code(405).header('Allow', 'GET, HEAD').send({
            error: 'Method not allowed', type: 'about:blank', title: 'Method Not Allowed',
            status: 405, detail: 'Method not allowed', requestId: _request.id,
          })
        }
      },
      handler: async (_request, reply) => {
        const available = kind === 'live' || await ready()
        return reply.code(available ? 200 : 503).send({
          state: available ? (kind === 'live' ? 'alive' : 'ready') : 'unavailable',
        })
      },
    })
  }
}
