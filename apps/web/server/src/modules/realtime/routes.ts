import type { FastifyInstance } from 'fastify'
import type { PrincipalTransactions } from '../../db/context.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import type { SessionService } from '../auth/sessions.ts'
import { uuidSchema, emptyQuerySchema } from '../files/http-schema.ts'
import { createTicketService } from './tickets.ts'
import { createRealtimeRegistry } from './sessions.ts'
import { createRealtimeState } from './state.ts'
import { createRealtimeDispatcher } from './dispatch.ts'
import { createRealtimeCommands, type RealtimeCommandPolicy } from './commands.ts'
import { createRealtimeGateway, type RealtimeGateway, type RealtimeOptions } from './gateway.ts'

type RealtimeDeps = {
  transactions: PrincipalTransactions; sessions: SessionService
  csrf: ReturnType<typeof createCsrfService>; origin: string; options?: RealtimeOptions; commandPolicy?: RealtimeCommandPolicy;channelNotifications?:(token:string,fileId:string)=>Promise<{conversationId:string;sequence:number}[]>
}
export function registerRealtimeRoutes(app: FastifyInstance, { transactions, sessions, csrf, origin, options = {}, commandPolicy,channelNotifications }: RealtimeDeps) {
  const tickets = createTicketService({ transactions, ttlMs: options.ticketTtlMs })
  const state = createRealtimeState({ transactions })
  const registry = createRealtimeRegistry({ heartbeatIntervalMs: options.heartbeatIntervalMs })
  const commands = createRealtimeCommands({ transactions, registry, state, policy: commandPolicy, ackTimeoutMs: options.ackTimeoutMs })
  const dispatcher = createRealtimeDispatcher({ registry, state, commands,channelNotifications })
  let gateway: RealtimeGateway
  try { gateway = createRealtimeGateway({ server: app.server, origin, sessions, csrf, tickets, registry, dispatcher, pollIntervalMs: options.pollIntervalMs }) }
  catch (error) { registry.close(); throw error }
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, true); csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })
    api.post<{ Body: { fileId: string; editorId: string | null } }>('/api/v1/realtime/ticket', {
      bodyLimit: 4096,
      schema: { querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: ['fileId', 'editorId'], properties: { fileId: uuidSchema, editorId: { anyOf: [uuidSchema, { type: 'null' }] } } } },
    }, async (request, reply) => {
      const token = cookies(request).session ?? '', principal = await sessions.authenticate(token)
      return reply.code(201).send({ ticket: await tickets.issue(token, principal, request.body.fileId, request.body.editorId) })
    })
  })
  app.addHook('preClose', async () => { gateway.close() })
  app.addHook('onClose', async () => { await gateway.drain() })
  return { ...gateway, dispatchToEditor: dispatcher.dispatchToEditor }
}
export type RealtimeServer = ReturnType<typeof registerRealtimeRoutes>
