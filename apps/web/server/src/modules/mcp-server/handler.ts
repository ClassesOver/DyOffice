import type { FastifyReply, FastifyRequest } from 'fastify'
import { uniqueHeader } from '../auth/csrf.ts'
import type { McpExternalCredential } from './credential.ts'
import { createOfficeReadTool, officeReadDescriptor } from './office-read.ts'
import { createMcpPdfRotation, pdfRotationDescriptor } from './pdf-rotation.ts'
import { createMcpXlsxCells, xlsxCellsDescriptor } from './xlsx-cells.ts'
import { createMcpPptxNotes, pptxNotesDescriptor } from './pptx-notes.ts'
import { createMcpDocxParagraph, docxParagraphDescriptor } from './docx-paragraph.ts'
import type { McpFileGrant } from '../../db/context.ts'

export const modernVersion = '2026-07-28'
export const mcpServerInfo = { name: 'DyOffice', version: '1.0.0' }

const prefix = 'io.modelcontextprotocol/'
const protocolVersion = prefix + 'protocolVersion'
export const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const mcpReadTool = {
  name: officeReadDescriptor.name,
  description: 'Read text from the immutable DOCX, XLSX, PPTX, or PDF revision authorized by this grant.',
  inputSchema: officeReadDescriptor.inputSchema,
  outputSchema: officeReadDescriptor.outputSchema,
  annotations: { readOnlyHint: true },
}

const mcpPdfRotationTool = {
  name: pdfRotationDescriptor.name,
  description: 'Rotate the pre-approved one-based PDF pages and save one revision. Retry the same arguments to recover its receipt.',
  inputSchema: pdfRotationDescriptor.inputSchema,
  outputSchema: pdfRotationDescriptor.outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}

const mcpXlsxCellsTool = {
  name: xlsxCellsDescriptor.name,
  description: 'Write pre-approved literal values to the exact XLSX cells and save one revision.',
  inputSchema: xlsxCellsDescriptor.inputSchema,
  outputSchema: xlsxCellsDescriptor.outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}

const mcpPptxNotesTool = {
  name: pptxNotesDescriptor.name,
  description: 'Replace speaker notes on the exact pre-approved PPTX slide and save one revision.',
  inputSchema: pptxNotesDescriptor.inputSchema,
  outputSchema: pptxNotesDescriptor.outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}

const mcpDocxParagraphTool = {
  name: docxParagraphDescriptor.name,
  description: 'Replace text of the exact pre-approved DOCX body paragraph and save one revision.',
  inputSchema: docxParagraphDescriptor.inputSchema,
  outputSchema: docxParagraphDescriptor.outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}

export function createMcpTools({ read, replaceParagraph, rotate, setCells, setNotes, inspect }: {
  read: ReturnType<typeof createOfficeReadTool>
  replaceParagraph: ReturnType<typeof createMcpDocxParagraph>
  rotate: ReturnType<typeof createMcpPdfRotation>
  setCells?: ReturnType<typeof createMcpXlsxCells>
  setNotes?: ReturnType<typeof createMcpPptxNotes>
  inspect: (credential: McpExternalCredential) => Promise<McpFileGrant>
}) {
  const failure = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })
  const executors = new Map<string, (credential: McpExternalCredential, args: unknown, signal: AbortSignal) => Promise<unknown>>([
    [mcpReadTool.name, read], [mcpPdfRotationTool.name, rotate], [mcpDocxParagraphTool.name, replaceParagraph],
  ])
  if (setCells) executors.set(mcpXlsxCellsTool.name, setCells)
  if (setNotes) executors.set(mcpPptxNotesTool.name, setNotes)
  return {
    async list(credential: McpExternalCredential) {
      const grant = await inspect(credential)
      if (grant.approval?.kind === 'pdf.rotate') return [mcpReadTool, mcpPdfRotationTool]
      if (setCells && grant.approval?.kind === 'xlsx.cells') return [mcpReadTool, mcpXlsxCellsTool]
      if (setNotes && grant.approval?.kind === 'pptx.notes') return [mcpReadTool, mcpPptxNotesTool]
      if (grant.approval?.kind === 'docx.paragraph') return [mcpReadTool, mcpDocxParagraphTool]
      return [mcpReadTool]
    },
    async run(credential: McpExternalCredential, name: unknown, args: unknown, signal: AbortSignal) {
      const execute = typeof name === 'string' ? executors.get(name) : undefined
      if (!execute) return failure('Tool unavailable for this grant')
      try {
        const result = await execute(credential, args, signal)
        return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 400) return failure('Invalid tool arguments')
        if (status === 403) return failure('Tool unavailable for this grant')
        if (status === 409) return failure('The saved revision or active edit lease changed')
        if (status === 422) return failure('The approved edit could not be applied to this saved revision')
        return failure(name === mcpReadTool.name ? 'Saved document unavailable' : 'Document edit unavailable')
      }
    },
  }
}

export type McpTools = ReturnType<typeof createMcpTools>

export function mcpError(reply: FastifyReply, status: number, id: unknown, code: number, message: string, data?: unknown) {
  return reply.code(status).send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

export function acceptsMcp(request: FastifyRequest) {
  const accept = request.headers.accept?.split(',').map(part => {
    const [type, ...parameters] = part.trim().split(';')
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='))?.trim().slice(2)
    return quality === undefined || Number(quality) > 0 ? type.trim().toLowerCase() : undefined
  })
  return accept?.includes('application/json') && accept.includes('text/event-stream')
}

function decodeName(header: string | undefined) {
  const start = '=?base64?'
  if (!header?.startsWith(start)) return header
  if (!header.endsWith('?=')) throw Error('Invalid encoded name')
  const data = header.slice(start.length, -2)
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw Error('Invalid encoded name')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function isVersionedMessage(request: FastifyRequest) {
  const body = object(request.body)
  return body?.method === 'server/discover' || object(object(body?.params)?._meta)?.[protocolVersion] !== undefined ||
    request.headers['mcp-method'] !== undefined || request.headers['mcp-protocol-version'] === modernVersion
}

export async function handleModernMcp(request: FastifyRequest, reply: FastifyReply, credential: McpExternalCredential, tools: McpTools, supportedVersions: readonly string[]) {
  const body = object(request.body)
  const id = body?.id
  const validId = typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))
  if (!body || body.jsonrpc !== '2.0' || !validId || typeof body.method !== 'string' || !body.method) {
    return mcpError(reply, 400, validId ? id : null, -32600, 'Invalid request')
  }
  if (!acceptsMcp(request)) return mcpError(reply, 406, id, -32600, 'Accept must allow JSON and event streams')
  const params = object(body.params)
  const metadata = object(params?._meta)
  const version = metadata?.[protocolVersion]
  const method = body.method
  const mismatch = () => mcpError(reply, 400, id, -32020, 'MCP metadata headers must match the request')
  try {
    if (typeof version !== 'string' || version !== uniqueHeader(request, 'mcp-protocol-version') ||
      method !== uniqueHeader(request, 'mcp-method')) return mismatch()
    const name = method === 'resources/read' ? params?.uri : params?.name
    if (['tools/call', 'resources/read', 'prompts/get'].includes(method) &&
      (typeof name !== 'string' || name !== decodeName(uniqueHeader(request, 'mcp-name')))) return mismatch()
  } catch { return mismatch() }

  if (version !== modernVersion) {
    return mcpError(reply, 400, id, -32022, 'Unsupported protocol version', { supported: supportedVersions, requested: version })
  }
  const client = object(metadata?.[prefix + 'clientInfo'])
  if ((metadata?.[prefix + 'clientInfo'] !== undefined &&
    (!client || typeof client.name !== 'string' || !client.name || typeof client.version !== 'string' || !client.version)) ||
    !object(metadata?.[prefix + 'clientCapabilities'])) {
    return mcpError(reply, 400, id, -32602, 'Invalid client metadata')
  }

  const complete = (result: Record<string, unknown>) => ({
    jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { [prefix + 'serverInfo']: mcpServerInfo }, ...result },
  })
  const cache = { ttlMs: 0, cacheScope: 'private' }
  switch (method) {
    case 'server/discover':
      return complete({ supportedVersions, capabilities: { tools: {} }, ...cache })
    case 'ping':
      return complete({})
    case 'tools/list':
      return complete({ tools: await tools.list(credential), ...cache })
    case 'tools/call': {
      const disconnect = new AbortController()
      const close = () => disconnect.abort()
      reply.raw.once('close', close)
      if (reply.raw.destroyed) close()
      try {
        return complete(await tools.run(credential, params?.name, params?.arguments, disconnect.signal))
      } finally { reply.raw.off('close', close) }
    }
    default:
      return mcpError(reply, 404, id, -32601, 'Method not found')
  }
}
