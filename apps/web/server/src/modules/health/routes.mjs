function stateBody(value) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['state'],
    properties: { state: { enum: [value] } },
  }
}

function querystring() {
  return { type: 'object', additionalProperties: false, properties: {} }
}

// Static application schemas only. Each registration gets its own objects
// because Fastify marks them while compiling. Do not compile schemas from
// requests, MCP tool descriptions, or other untrusted input.
export function healthSchemas() {
  return {
    live: {
      querystring: querystring(),
      response: { 200: stateBody('alive') },
    },
    ready: {
      querystring: querystring(),
      response: {
        200: stateBody('ready'),
        503: stateBody('unavailable'),
      },
    },
  }
}

export function registerHealthRoutes(app, { readyCheck }) {
  const schemas = healthSchemas()
  app.get('/api/v1/health/live', { schema: schemas.live }, async () => ({ state: 'alive' }))
  app.get('/api/v1/health/ready', { schema: schemas.ready }, async (_request, reply) => {
    let ready = false
    try {
      ready = (await readyCheck()) === true
    } catch {
      ready = false
    }
    if (!ready) {
      reply.code(503)
      return { state: 'unavailable' }
    }
    return { state: 'ready' }
  })
}
