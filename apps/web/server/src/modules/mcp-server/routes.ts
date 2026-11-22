import type { FastifyInstance, FastifyRequest } from 'fastify'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { authError } from '../auth/sessions.ts'
import type { FileService } from '../files/service.ts'
import type { McpPrincipalTransactions } from '../../db/context.ts'
import { createMcpCredentialReader } from './credential.ts'
import { handleModernMcp, isVersionedMessage, modernVersion } from './handler.ts'
import { createOfficeReadTool, officeReadDescriptor } from './office-read.ts'
import { createLegacyMcp, legacyVersion } from './legacy.ts'
import { createMcpReadGrants } from './read-grants.ts'

export function registerMcpRoutes(app: FastifyInstance, transactions: McpPrincipalTransactions, files: FileService, csrf: ReturnType<typeof createCsrfService>) {
  const grants = createMcpReadGrants(transactions)
  const read = createOfficeReadTool(files)
  const legacy = createLegacyMcp(app, read)
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
        await grants.inspect(credential)
        if (isVersionedMessage(request)) {
          if (request.method !== 'POST') return reply.header('Allow', 'POST').code(405).send()
          return handleModernMcp(request, reply, credential, read, [modernVersion, legacyVersion])
        }
        return legacy(request, reply, credential)
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 401) throw error
        return reply.header('WWW-Authenticate', 'Bearer').code(401).send()
      }
    },
  })
}
