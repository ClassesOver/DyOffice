import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { authError } from '../auth/sessions.ts'
import type { FilePolicy, FileService } from '../files/service.ts'
import type { McpPrincipalTransactions } from '../../db/context.ts'
import { createMcpCredentialReader } from './credential.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { createMcpPdfRotation, parsePdfRotation, pdfRotationDescriptor } from './pdf-rotation.ts'
import { createMcpTools, handleModernMcp, isVersionedMessage, modernVersion, object } from './handler.ts'
import { createOfficeReadTool, officeReadDescriptor } from './office-read.ts'
import { createLegacyMcp, legacyVersion } from './legacy.ts'
import { createMcpReadGrants } from './read-grants.ts'

export function registerMcpRoutes(app: FastifyInstance, transactions: McpPrincipalTransactions, files: FileService, csrf: ReturnType<typeof createCsrfService>, objects: ObjectStore, filePolicy?: FilePolicy) {
  const grants = createMcpReadGrants(transactions)
  const read = createOfficeReadTool(files)
  const tools = createMcpTools({ read, rotate: createMcpPdfRotation({ transactions, objects, filePolicy }), inspect: grants.inspect })
  const legacy = createLegacyMcp(app, tools)
  const readCredential = createMcpCredentialReader({ environment: process.env.NODE_ENV ?? 'production' })
  const sessionFor = (request: FastifyRequest) => {
    const token = cookies(request).session
    if (!token) throw authError()
    csrf.requireSession(request, token)
    return token
  }
  app.post('/api/v1/mcp/read-grants', { bodyLimit: 2048, schema: { body: officeReadDescriptor.inputSchema } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const session = sessionFor(request)
    const { fileId, revision } = request.body as { fileId: string; revision: string }
    return reply.code(201).send(await grants.issue(session, { fileId, revision }))
  })
  app.post('/api/v1/mcp/pdf-rotation-grants', { bodyLimit: 4096, schema: { body: pdfRotationDescriptor.inputSchema } }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    const session = sessionFor(request)
    const { fileId, revision, pages, degrees } = parsePdfRotation(request.body)
    return reply.code(201).send(await grants.issue(session, { fileId, revision }, { pages, degrees }))
  })
  app.delete<{ Params: { id: string } }>('/api/v1/mcp/read-grants/:id', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await grants.revoke(sessionFor(request), request.params.id)
    return reply.code(204).send()
  })

  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    bodyLimit: 16 * 1024,
    async handler(request, reply) {
      reply.header('Cache-Control', 'private, no-store')
      csrf.originCheck(request, false)
      const [, query = ''] = request.url.split(/\?(.*)/s, 2)
      try {
        const credential = readCredential({ path: '/mcp', rawHeaders: request.raw.rawHeaders, query })
        const modern = isVersionedMessage(request)
        const body = object(request.body)
        if (!modern && request.method === 'POST' && body?.method === 'notifications/cancelled' && !Object.hasOwn(body, 'id')) {
          await transactions.authenticateMcpCancellation(credential)
        } else {
          await grants.inspect(credential)
        }
        if (modern) {
          if (request.method !== 'POST') return reply.header('Allow', 'POST').code(405).send()
          return handleModernMcp(request, reply, credential, tools, [modernVersion, legacyVersion])
        }
        return legacy(request, reply, credential)
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 401) throw error
        return reply.header('WWW-Authenticate', 'Bearer').code(401).send()
      }
    },
  })
}
