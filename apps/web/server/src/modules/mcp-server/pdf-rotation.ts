import { randomUUID } from 'node:crypto'
import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import type { RevisionRef } from '../../../../../../packages/web-contracts/src/api.ts'
import { mcpPdfRotationKey, type McpPrincipalTransactions, type PrincipalTransactions } from '../../db/context.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { createPdfSavePreparation } from '../../pdf/save-preparation.mjs'
import { createIsolatedPdfPageOpsJob } from '../../pdf/page-ops-isolated.mjs'
import { authError, tokenHash } from '../auth/sessions.ts'
import { loadFile, scope, uuid } from '../files/queries.ts'
import { createFileService, type FilePolicy } from '../files/service.ts'
import { createLeaseService } from '../leases/service.ts'
import { createRevisionService } from '../revisions/service.ts'
import type { McpExternalCredential } from './credential.ts'
import { officeReadDescriptor } from './office-read.ts'

const { fileId, revision } = officeReadDescriptor.inputSchema.properties

export const pdfRotationDescriptor = {
  name: 'rotate_pdf_pages',
  schemaVersion: 1,
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['fileId', 'revision', 'pages', 'degrees'],
    properties: {
      fileId, revision,
      pages: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 100 } },
      degrees: { type: 'integer', enum: [-90, 90, 180] },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['fileId', 'revision', 'sha256', 'size'],
    properties: { fileId, revision, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, size: { type: 'integer', minimum: 1 } },
  },
  effect: 'document_write',
  executionMode: 'headless',
  requiresActiveEditor: false,
  requiredScopes: ['files:write'],
  maxDurationMs: 45_000,
} satisfies ToolDescriptor

export function parsePdfRotation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4) throw authError(400)
  const input = value as Record<string, unknown>
  const { pages, degrees } = input
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100 || new Set(pages).size !== pages.length ||
    pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > 100) ||
    (degrees !== -90 && degrees !== 90 && degrees !== 180)) throw authError(400)
  return { fileId: uuid(input.fileId as string), revision: uuid(input.revision as string), pages: [...pages].sort((a, b) => a - b), degrees }
}

export function createMcpPdfRotation({ transactions, objects, filePolicy }: { transactions: McpPrincipalTransactions; objects: ObjectStore; filePolicy?: FilePolicy }) {
  const processor = createIsolatedPdfPageOpsJob()
  return async (credential: McpExternalCredential, args: unknown, signal: AbortSignal): Promise<RevisionRef> => {
    const requested = parsePdfRotation(args)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(pdfRotationDescriptor.maxDurationMs)])
    deadline.throwIfAborted()
    const grant = await transactions.inspectMcpReadScope(credential)
    const approved = grant.pdfRotation
    if (!approved || requested.fileId !== grant.fileId || requested.revision !== grant.revision ||
      requested.degrees !== approved.degrees || requested.pages.length !== approved.pages.length ||
      requested.pages.some((page, index) => page !== approved.pages[index])) throw authError(403)
    const { fileId, revision: baseRevision } = grant
    const token = credential.token
    const editorId = randomUUID()
    const idempotencyKey = mcpPdfRotationKey(grant.id)
    const scoped = (publication?: { uploadId: string; signal: AbortSignal }): PrincipalTransactions => ({
      sessionIdleMs: transactions.sessionIdleMs,
      // Existing save services want a string. This private adapter resolves it
      // only as the approved MCP grant, through the dedicated transaction.
      withPrincipalTransaction: (input, operation) => {
        if (input.kind !== 'session' || input.token !== token) throw authError()
        return transactions.withMcpPdfRotationTransaction(credential, grant, async (connection, principal) => {
          const result = await operation(connection, principal)
          if (publication) {
            const { rows: [row] } = await connection.query<{ recorded: boolean }>(
              'SELECT record_mcp_pdf_rotation($1,$2,$3,$4) AS recorded',
              [principal.deploymentId, tokenHash(token), transactions.sessionIdleMs, publication.uploadId],
            )
            if (!row.recorded) throw authError(409)
          }
          return result
        }, { signal: publication?.signal, publishingGrant: publication !== undefined })
      },
    })
    const authority = scoped()
    const files = createFileService({ ...filePolicy, transactions: authority, objects })
    const leases = createLeaseService({ transactions: authority, ttlMs: 60_000, assertOfficeWritable: files.assertOfficeWritable })
    const revisions = createRevisionService({ ...filePolicy, transactions: authority, objects, files })
    async function receipt(): Promise<RevisionRef | undefined> {
      return transactions.withMcpPdfRotationTransaction(credential, grant, async (connection, principal) => {
        const file = await loadFile(connection, principal, fileId)
        const savedRevision = principal.mcpRead?.resultRevision
        if (savedRevision) {
          const { rows: [saved] } = await connection.query<{ revision: string; sha256: string; size: number }>(
            'SELECT id AS revision,sha256,size FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 AND id=$4 AND reclaimed_at IS NULL',
            [...scope(principal), fileId, savedRevision],
          )
          if (!saved) throw authError(404)
          return { fileId, ...saved }
        }
        if (file.current_revision !== baseRevision) throw authError(409)
      }, { signal: deadline })
    }

    const prior = await receipt()
    if (prior) return prior
    deadline.throwIfAborted()
    const { leaseEpoch } = await leases.acquireLease(token, fileId, { editorId })
    let uploadId: string | undefined
    try {
      // Another caller may have finished between the first lookup and lease acquisition.
      const replay = await receipt()
      if (replay) return replay
      const prepare = createPdfSavePreparation({ files, leases, revisions, processor })
      const staged = await prepare.prepare({
        token, fileId, baseRevision, editorId, leaseEpoch, idempotencyKey,
        request: JSON.stringify({
          version: 1, action: 'pageOps',
          operations: [{ op: 'rotatePages', pages: requested.pages, dir: requested.degrees }],
        }),
      }, { signal: deadline })
      const commitInput: Parameters<typeof revisions.commitRevision>[1] = staged.commitInput
      uploadId = commitInput.uploadId
      deadline.throwIfAborted()
      const commit = createRevisionService({ ...filePolicy, transactions: scoped({ uploadId: commitInput.uploadId, signal: deadline }), objects, files })
      return await commit.commitRevision(token, commitInput)
    } finally {
      if (uploadId) await files.cancelUpload(token, uploadId).catch(() => {})
      await leases.releaseLease(token, fileId, { editorId, leaseEpoch }).catch(() => {})
    }
  }
}
