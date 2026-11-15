import type { FastifyInstance } from 'fastify'
import type { createCsrfService } from '../auth/csrf.ts'
import type { SessionService } from '../auth/sessions.ts'
import { cookies } from '../auth/csrf.ts'
import type { createPreferenceService } from './service.ts'

const patchSchema = { type: 'object', additionalProperties: false, properties: { theme: { type: 'string', enum: ['light','dark','system'] }, language: { type: 'string', enum: ['zh','en'] }, authorName: { type: 'string', maxLength: 100 }, autoSave: { type: 'boolean' }, showAssistant: { type: 'boolean' } } } as const
export function registerPreferenceRoutes(app: FastifyInstance, preferences: ReturnType<typeof createPreferenceService>, sessions: SessionService, csrf: ReturnType<typeof createCsrfService>) {
  for (const url of ['/api/preferences','/api/v1/preferences']) {
    app.get(url, { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } }, async request => {
      const token = cookies(request).session ?? ''
      await sessions.authenticate(token) // Touch activity; the business transaction independently revalidates authority.
      return preferences.get(token)
    })
    app.put(url, { bodyLimit: 4096, schema: { body: patchSchema, querystring: { type: 'object', additionalProperties: false, properties: {} } } }, async request => {
      const token = cookies(request).session
      csrf.requireSession(request, token)
      await sessions.authenticate(token!)
      return preferences.update(token!, request.body)
    })
  }
}
