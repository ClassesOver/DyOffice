import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { tokenHash } from '../auth/sessions.ts'
import { uniqueHeader } from '../auth/csrf.ts'
import type { McpExternalCredential } from './credential.ts'
import { mcpError, mcpServerInfo, object, type McpTools } from './handler.ts'

export const legacyVersion = '2025-11-25'
const MAX_SESSIONS = 64
const MAX_SESSIONS_PER_GRANT = 4
const SESSION_TTL_MS = 10 * 60_000

export function createLegacyMcp(app: FastifyInstance, tools: McpTools) {
  const sessions = new Map<string, {
    ownerHash: string
    expiresAt: number
    transport: WebStandardStreamableHTTPServerTransport
  }>()
  app.addHook('preClose', async () => {
    await Promise.all([...sessions.values()].map(session => session.transport.close()))
    sessions.clear()
  })

  return async (request: FastifyRequest, reply: FastifyReply, credential: McpExternalCredential) => {
    const body = object(request.body)
    const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null
    let sessionId: string | undefined
    let version: string | undefined
    try {
      sessionId = uniqueHeader(request, 'mcp-session-id')
      version = uniqueHeader(request, 'mcp-protocol-version')
    } catch {
      return mcpError(reply, 400, id, -32600, 'Invalid MCP header')
    }
    // The optional standalone GET stream carries no events for this tool.
    if (request.method === 'GET') return reply.header('Allow', 'POST, DELETE').code(405).send()
    const initialize = request.method === 'POST' && isInitializeRequest(body)
    if (initialize ? body.params.protocolVersion !== legacyVersion || (version !== undefined && version !== legacyVersion) : version !== legacyVersion) {
      return mcpError(reply, 400, id, -32602, 'Unsupported legacy protocol version')
    }
    if (request.method === 'POST' && !body) return mcpError(reply, 400, id, -32600, 'Expected one JSON-RPC message')
    if (initialize && sessionId !== undefined) return mcpError(reply, 400, id, -32600, 'Initialize requires a new session')

    const now = performance.now()
    const expired = [...sessions.values()].filter(session => session.expiresAt <= now)
    await Promise.all(expired.map(session => session.transport.close()))
    const ownerHash = tokenHash(credential.token)
    let session = sessionId ? sessions.get(sessionId) : undefined
    if (sessionId && session?.ownerHash !== ownerHash) {
      return mcpError(reply, 404, id, -32602, 'MCP session unavailable')
    }

    if (!session && initialize) {
      if (sessions.size >= MAX_SESSIONS || [...sessions.values()].filter(existing => existing.ownerHash === ownerHash).length >= MAX_SESSIONS_PER_GRANT) {
        return mcpError(reply, 503, id, -32603, 'MCP session capacity reached')
      }
      const newId = randomUUID()
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => newId })
      const server = new Server(mcpServerInfo, { capabilities: { tools: {} } })
      transport.onclose = () => { sessions.delete(newId) }
      server.setRequestHandler(ListToolsRequestSchema, async (_request, context) => ({
        tools: await tools.list({ kind: 'external-token', token: context.authInfo!.token }),
      }))
      server.setRequestHandler(CallToolRequestSchema, async ({ params }, context) => {
        try {
          return await tools.run({ kind: 'external-token', token: context.authInfo!.token }, params.name, params.arguments, context.signal)
        } finally {
          if (context.signal.aborted) transport.closeSSEStream(context.requestId)
        }
      })
      session = { ownerHash, expiresAt: now + SESSION_TTL_MS, transport }
      sessions.set(newId, session)
      try { await server.connect(transport) } catch (error) {
        await transport.close()
        throw error
      }
    }
    if (!session) return mcpError(reply, 400, id, -32600, 'MCP initialization required')

    // Forward only standard transport metadata. The credential is supplied to
    // the SDK separately and is never part of the transport session state.
    const headers = new Headers()
    for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id']) {
      const value = request.headers[name]
      if (typeof value === 'string') headers.set(name, value)
    }
    const response = await session.transport.handleRequest(new Request('http://localhost/mcp', {
      method: request.method, headers,
    }), {
      parsedBody: body,
      authInfo: { token: credential.token, clientId: 'dyoffice-read-grant', scopes: ['files:read'] },
    })
    if (initialize && response.status !== 200) await session.transport.close()
    response.headers.forEach((value, name) => {
      if (name !== 'cache-control' && name !== 'connection') reply.header(name, value)
    })
    return reply.code(response.status).send(response.body ?? undefined)
  }
}
