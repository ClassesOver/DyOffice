import type { FastifyInstance } from 'fastify'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { authError } from '../auth/sessions.ts'
import { channelUuid } from '../../../../../../packages/web-contracts/src/assistant-channel.ts'
import { streamTaskEvents } from './event-stream.ts'

type Page = { events: readonly { sequence: number }[], state?: string }
type ReadTask = (token: string, task: string, document: string, after: number) => Promise<Page>
type ReadChannel = (token: string, channel: string, after: number, task?: string) => Promise<Page>
type Query = { documentId?: string, conversationId?: string, feed?: string, after?: string }

export function registerTaskEventRoutes(app: FastifyInstance, csrf: ReturnType<typeof createCsrfService>, coding?: ReadTask, channel?: ReadChannel) {
  app.get<{ Params: {id: string}, Querystring: Query }>('/api/v1/assistant/tasks/:id/events', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const token = cookies(request).session
    if (!token) throw authError()
    csrf.requireSessionRead(request, token)
    const { documentId, conversationId, feed, after = '0' } = request.query
    const { id } = request.params
    const cursor = Number(after)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof after !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(after) || !Number.isSafeInteger(cursor)) throw authError(400)
    if (documentId !== undefined && conversationId === undefined && feed === undefined) {
      const document = channelUuid(documentId)
      if (cursor > 4096) throw authError(400)
      if (!coding) throw authError(404)
      return streamTaskEvents(reply, cursor, next => coding(token, id, document, next))
    }
    if (documentId !== undefined || (feed !== undefined && feed !== 'channel')) throw authError(400)
    const aggregate = feed === 'channel'
    if (aggregate && conversationId !== undefined) throw authError(400)
    if (!aggregate && conversationId === undefined) throw authError(400)
    const conversation = channelUuid(aggregate ? id : conversationId)
    const task = aggregate ? undefined : channelUuid(id)
    if (!channel) throw authError(404)
    return streamTaskEvents(reply, cursor, next => channel(token, conversation, next, task))
  })
}
