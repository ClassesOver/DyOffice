import { addAbortListener } from 'node:events'
import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import type { OfficeReadCredential } from '../../db/context.ts'
import { authError } from '../auth/sessions.ts'
import {
  DOCUMENT_PARSE_TIMEOUT_MS,
  DOCUMENT_READ_MAX_BYTES,
  readBackgroundDocument,
} from '../assistant-channel/background-read.ts'
import { uuid } from '../files/queries.ts'
import type { FileService } from '../files/service.ts'

const uuidSchema = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
}

export const officeReadDescriptor = {
  name: 'read_saved_document',
  schemaVersion: 1,
  effect: 'read',
  executionMode: 'headless',
  requiresActiveEditor: false,
  requiredScopes: ['files:read'],
  maxDurationMs: DOCUMENT_PARSE_TIMEOUT_MS * 2,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { fileId: uuidSchema, revision: uuidSchema },
    required: ['fileId', 'revision'],
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fileId: uuidSchema,
      revision: uuidSchema,
      format: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'] },
      text: { type: 'string' },
      truncated: { type: 'boolean' },
    },
    required: ['fileId', 'revision', 'format', 'text', 'truncated'],
  },
} satisfies ToolDescriptor

// Transport authentication supplies the credential separately from tool arguments.
export function createOfficeReadTool(files: Pick<FileService, 'assertReadableRevision' | 'download'>) {
  let activeReads = 0
  return async (credential: OfficeReadCredential, args: unknown, signal: AbortSignal) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 2) {
      throw authError(400)
    }
    const { fileId: requestedFileId, revision: requestedRevision } = args as Record<string, unknown>
    if (typeof requestedFileId !== 'string' || typeof requestedRevision !== 'string') throw authError(400)
    const fileId = uuid(requestedFileId)
    const revision = uuid(requestedRevision)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(officeReadDescriptor.maxDurationMs)])
    deadline.throwIfAborted()
    if (activeReads >= 4) throw authError(503)
    const authorizedCredential = typeof credential === 'string' ? credential : { ...credential }
    let abortSubscription: ReturnType<typeof addAbortListener>
    const cancellation = new Promise<never>((_resolve, reject) => {
      abortSubscription = addAbortListener(deadline, () => reject(deadline.reason))
    })
    const read = async () => {
      const { bytes, format } = await files.download(authorizedCredential, fileId, revision, DOCUMENT_READ_MAX_BYTES, deadline)
      deadline.throwIfAborted()
      if (format === 'csv' || format === 'xlsm') throw authError(415)
      const document = await readBackgroundDocument(bytes, format, deadline, { visibleOnly: typeof authorizedCredential !== 'string' && authorizedCredential.kind === 'external-token' })
      // Parsing runs outside the download transaction. Recheck the same revision before returning text.
      deadline.throwIfAborted()
      await files.assertReadableRevision(authorizedCredential, fileId, revision, deadline)
      deadline.throwIfAborted()
      return { fileId, revision, format, ...document }
    }
    activeReads++
    const running = read().finally(() => { activeReads-- })
    try {
      return await Promise.race([cancellation, running])
    } finally {
      abortSubscription![Symbol.dispose]()
    }
  }
}
