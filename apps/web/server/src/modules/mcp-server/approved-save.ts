import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { RevisionRef } from '../../../../../../packages/web-contracts/src/api.ts'
import { mcpEditKey, type McpEditApproval, type McpPrincipalTransactions, type McpReadScope, type PrincipalTransactions } from '../../db/context.ts'
import type { ObjectStore } from '../../storage/object-store.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { loadFile, scope } from '../files/queries.ts'
import { createFileService, type FilePolicy, type FileService } from '../files/service.ts'
import { createLeaseService, type LeaseService } from '../leases/service.ts'
import { createRevisionService, type RevisionService } from '../revisions/service.ts'
import { officeReadDescriptor } from './office-read.ts'
import type { McpExternalCredential } from './credential.ts'

const { fileId, revision } = officeReadDescriptor.inputSchema.properties
export const approvedSaveResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['fileId', 'revision', 'sha256', 'size'],
  properties: { fileId, revision, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, size: { type: 'integer', minimum: 1 } },
}

export interface ApprovedSaveInput {
  files: FileService
  leases: LeaseService
  revisions: RevisionService
  token: string
  fileId: string
  baseRevision: string
  editorId: string
  leaseEpoch: number
  idempotencyKey: string
  signal: AbortSignal
}

export interface ApprovedSaveOptions {
  transactions: McpPrincipalTransactions
  objects: ObjectStore
  filePolicy?: FilePolicy
}

export function createApprovedOfficeSave({ transactions, objects, filePolicy }: ApprovedSaveOptions) {
  return async (
    credential: McpExternalCredential, target: McpReadScope, requestedApproval: McpEditApproval,
    deadline: AbortSignal, prepare: (input: ApprovedSaveInput) => Promise<{ uploadId: string }>,
  ): Promise<RevisionRef> => {
    deadline.throwIfAborted()
    const grant = await transactions.inspectMcpReadScope(credential)
    if (target.fileId !== grant.fileId || target.revision !== grant.revision ||
      !isDeepStrictEqual(grant.approval, requestedApproval)) throw authError(403)
    const { fileId, revision: baseRevision } = grant
    const token = credential.token
    const editorId = randomUUID()
    const idempotencyKey = mcpEditKey(requestedApproval.kind, grant.id)
    const scoped = (publication?: { uploadId: string; signal: AbortSignal }): PrincipalTransactions => ({
      sessionIdleMs: transactions.sessionIdleMs,
      // Existing save services want a string. This private adapter resolves it
      // only as the approved MCP grant, through the dedicated transaction.
      withPrincipalTransaction: (input, operation) => {
        if (input.kind !== 'session' || input.token !== token) throw authError()
        return transactions.withMcpEditTransaction(credential, grant, async (connection, principal) => {
          const result = await operation(connection, principal)
          if (publication) {
            const { rows: [row] } = await connection.query<{ recorded: boolean }>(
              'SELECT record_mcp_edit($1,$2,$3,$4) AS recorded',
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
    const leases = createLeaseService({ transactions: authority, ttlMs: 60_000, assertOfficeWritable: file => files.assertOfficeWritable(file) })
    const revisions = createRevisionService({ ...filePolicy, transactions: authority, objects, files })
    async function receipt(): Promise<RevisionRef | undefined> {
      return transactions.withMcpEditTransaction(credential, grant, async (connection, principal) => {
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
      const staged = await prepare({ files, leases, revisions, token, fileId, baseRevision, editorId, leaseEpoch, idempotencyKey, signal: deadline })
      uploadId = staged.uploadId
      deadline.throwIfAborted()
      const commit = createRevisionService({ ...filePolicy, transactions: scoped({ uploadId, signal: deadline }), objects, files })
      const result = await commit.commitRevision(token, { fileId, baseRevision, leaseEpoch, idempotencyKey, uploadId })
      uploadId = undefined
      return result
    } finally {
      if (uploadId) await files.cancelUpload(token, uploadId).catch(() => {})
      await leases.releaseLease(token, fileId, { editorId, leaseEpoch }).catch(() => {})
    }
  }
}
