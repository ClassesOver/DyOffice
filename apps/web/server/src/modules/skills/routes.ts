import type { FastifyInstance } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { createSkillService } from './service.ts'

export function registerSkillRoutes(app: FastifyInstance, skills: ReturnType<typeof createSkillService>, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>) {
  const querystring = {type: 'object', additionalProperties: false, properties: {}} as const
  const params = {type: 'object', required: ['name'], additionalProperties: false, properties: {name: {type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$'}}} as const
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      await sessions.authenticate(token)
      if (request.method === 'GET' || request.method === 'HEAD') csrf.requireSessionRead(request, token)
      else csrf.requireSession(request, token)
    })
    api.get('/api/v1/skills', {schema: {querystring}}, request => skills.list(cookies(request).session!))
    api.get<{Params: {name: string}}>('/api/v1/skills/:name', {schema: {querystring, params}}, request => skills.read(cookies(request).session!, request.params.name))
    api.put<{Params: {name: string}}>('/api/v1/skills/:name', {bodyLimit: 300000, schema: {querystring, params, body: {type: 'object', additionalProperties: false, required: ['description','body'], properties: {description: {type: 'string', maxLength: 4096}, body: {type: 'string', minLength: 1, maxLength: 262144},overwrite:{type:'boolean'}}}}}, request => skills.save(cookies(request).session!, request.params.name, request.body))
    api.delete<{Params: {name: string}}>('/api/v1/skills/:name', {schema: {querystring, params}}, async (request, reply) => {
      await skills.remove(cookies(request).session!, request.params.name)
      return reply.code(204).send()
    })
  })
}
