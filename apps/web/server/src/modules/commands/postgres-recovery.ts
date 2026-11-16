import type { PrincipalTransactions } from '../../db/context.ts'
import {
  isRevisionRef,
  type RevisionRef,
} from '../../../../../../packages/web-contracts/src/api.ts'
import { authorize } from '../policy/authorize.ts'
import { authError } from '../auth/sessions.ts'
import { loadFile, scope, uuid } from '../files/queries.ts'
import { snapshotCommand } from './approval.ts'
import type { CommandRecord, CommandState } from './journal.ts'

export interface RecoveredCommand {
  commandId: string
  fileId: string
  state: CommandState
  digest: string
  revision?: RevisionRef
}
const states: readonly string[] = [
  'pending_approval',
  'approved',
  'unknown_outcome',
  'applied_uncommitted',
  'committed',
  'cancelled',
  'abandoned_uncommitted',
]
/** Read-only recovery projection, not a journal or execution capability. A fresh
 * editor may read its SAME authenticated session's historical receipt. The old
 * editor identity is checked only inside the durable provenance join. No lease
 * lookup/takeover, upload cleanup, implicit account creation or timestamp write. */
export function createPostgresCommandRecovery({
  transactions,
  token,
}: {
  transactions: PrincipalTransactions
  token: string
}) {
  const credential = Object.freeze({ kind: 'session' as const, token })
  return Object.freeze({
    async lookup(fileId: string, commandId: string): Promise<RecoveredCommand> {
      const file = uuid(fileId),
        id = uuid(commandId)
      if (file !== fileId || id !== commandId) throw authError(404)
      return transactions.withPrincipalTransaction(credential, async (c, p) => {
        if (p.job) throw authError(404)
        authorize(p, 'files:read', { deploymentId: p.deploymentId, ownerId: p.userId })
        authorize(p, 'files:write', { deploymentId: p.deploymentId, ownerId: p.userId })
        // Do NOT call lockAccount(): it creates accounts and expires uploads.
        const account = await c.query(
          'SELECT 1 FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE',
          scope(p),
        )
        if (account.rowCount !== 1) throw authError(404)
        await loadFile(c, p, file, false, 'UPDATE')
        const found = await c.query<{ record: CommandRecord }>(
          'SELECT record FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4 AND file_id=$5 FOR UPDATE',
          [...scope(p), p.sessionId, id, file],
        )
        const row = found.rows[0]?.record
        if (
          !row ||
          !states.includes(row.state) ||
          typeof row.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.digest)
        )
          throw authError(404)
        let envelope
        try {
          envelope = snapshotCommand(row.envelope)
        } catch {
          throw authError(404)
        }
        if (envelope.fileId !== file || envelope.commandId !== id) throw authError(404)
        const result: RecoveredCommand = {
          commandId: id,
          fileId: file,
          state: row.state,
          digest: row.digest,
        }
        if (row.state === 'committed') {
          const revision = row.revision
          if (
            !isRevisionRef(revision) ||
            revision.fileId !== file ||
            revision.revision === envelope.baseRevision
          )
            throw authError(404)
          // No caller-supplied editor ID: binding's original editor must still
          // match the committed upload. Everything else mirrors the write
          // verifier, including source, base, epoch, request key and exact bytes.
          const receipt = await c.query(
            `SELECT 1 FROM command_upload_bindings b
            JOIN revision_commits rc ON rc.deployment_id=b.deployment_id AND rc.owner_id=b.owner_id AND rc.file_id=b.file_id AND rc.upload_id=b.upload_id AND rc.idempotency_key=b.idempotency_key
            JOIN uploads u ON u.deployment_id=b.deployment_id AND u.owner_id=b.owner_id AND u.file_id=b.file_id AND u.id=b.upload_id
            JOIN file_revisions r ON r.deployment_id=rc.deployment_id AND r.owner_id=rc.owner_id AND r.file_id=rc.file_id AND r.id=rc.revision_id
            WHERE b.deployment_id=$1 AND b.owner_id=$2 AND b.session_id=$3 AND b.command_id=$4 AND b.file_id=$5
              AND rc.requested_source_command_id=b.command_id AND rc.base_revision=$6 AND rc.lease_epoch=$7 AND rc.job_id IS NULL
              AND u.session_id=b.session_id AND u.editor_id=b.editor_id AND u.base_revision=rc.base_revision AND u.lease_epoch=rc.lease_epoch AND u.state='committed' AND u.kind='revision' AND u.restored_from IS NULL
              AND u.sha256=b.sha256 AND u.expected_size=b.size AND r.source='save' AND r.parent_revision=rc.base_revision
              AND r.id=$8 AND r.sha256=$9 AND r.size=$10 AND r.sha256=b.sha256 AND r.size=b.size`,
            [
              ...scope(p),
              p.sessionId,
              id,
              file,
              envelope.baseRevision,
              envelope.leaseEpoch,
              revision.revision,
              revision.sha256,
              revision.size,
            ],
          )
          if (receipt.rowCount !== 1) throw authError(404)
          // Explicit projection: never return extra keys carried in database JSON.
          result.revision = {
            fileId: file,
            revision: revision.revision,
            sha256: revision.sha256,
            size: revision.size,
          }
        } else if (row.revision !== undefined) throw authError(404)
        return result
      })
    },
  })
}
