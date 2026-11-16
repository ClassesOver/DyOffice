/** Internal implementation only. Not re-exported by a public package/route. */
import type { PoolClient } from 'pg'
import type { PrincipalTransactions, BusinessPrincipal } from '../../db/context.ts'
import {
  isRevisionRef,
  type RevisionRef,
} from '../../../../../../packages/web-contracts/src/api.ts'
import { authorize } from '../policy/authorize.ts'
import { authError } from '../auth/sessions.ts'
import { loadFile, scope, uuid } from '../files/queries.ts'
import { snapshotCommand, canonicalCommandJson } from './approval.ts'
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
export interface LockedRecoveryCommand {
  c: PoolClient
  p: BusinessPrincipal
  file: string
  id: string
  record: CommandRecord
  baseRevision: string
}
export async function withLockedRecoveryCommand<T>(
  transactions: PrincipalTransactions,
  token: string,
  fileId: string,
  commandId: string,
  operation: (locked: LockedRecoveryCommand) => Promise<T>,
): Promise<T> {
  const file = uuid(fileId),
    id = uuid(commandId)
  if (file !== fileId || id !== commandId) throw authError(404)
  return transactions.withPrincipalTransaction(
    Object.freeze({ kind: 'session' as const, token }),
    async (c, p) => {
      if (p.job) throw authError(404)
      authorize(p, 'files:read', { deploymentId: p.deploymentId, ownerId: p.userId })
      authorize(p, 'files:write', { deploymentId: p.deploymentId, ownerId: p.userId })
      // Never use lockAccount: that would create accounts and expire uploads.
      const account = await c.query(
        'SELECT 1 FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE',
        scope(p),
      )
      if (account.rowCount !== 1) throw authError(404)
      const currentFile = await loadFile(c, p, file, false, 'UPDATE')
      const found = await c.query<{ record: CommandRecord }>(
        'SELECT record FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4 AND file_id=$5 FOR UPDATE',
        [...scope(p), p.sessionId, id, file],
      )
      const record = found.rows[0]?.record
      if (
        !record ||
        !states.includes(record.state) ||
        typeof record.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.digest)
      )
        throw authError(404)
      let envelope
      try {
        envelope = snapshotCommand(record.envelope)
      } catch {
        throw authError(404)
      }
      if (envelope.fileId !== file || envelope.commandId !== id) throw authError(404)
      if (record.state !== 'committed' && record.revision !== undefined) throw authError(404)
      return operation({ c, p, file, id, record, baseRevision: currentFile.current_revision })
    },
  )
}
/** Exact historical receipt only for the currently locked committed record. */
export async function verifyLockedRecoveryCommit(
  locked: LockedRecoveryCommand,
  record: CommandRecord,
  revision: RevisionRef,
): Promise<boolean> {
  const { c, p, file, id } = locked,
    envelope = locked.record.envelope
  if (
    locked.record.state !== 'committed' ||
    !isRevisionRef(revision) ||
    revision.fileId !== file ||
    revision.revision === envelope.baseRevision ||
    canonicalCommandJson(record) !== canonicalCommandJson(locked.record) ||
    canonicalCommandJson(revision) !== canonicalCommandJson(locked.record.revision)
  )
    return false
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

  return receipt.rowCount === 1
}
export async function projectRecoveryCommand(
  locked: LockedRecoveryCommand,
  row: CommandRecord = locked.record,
): Promise<RecoveredCommand> {
  const result: RecoveredCommand = {
    commandId: locked.id,
    fileId: locked.file,
    state: row.state,
    digest: row.digest,
  }
  if (row.state === 'committed') {
    if (!row.revision || !(await verifyLockedRecoveryCommit(locked, row, row.revision)))
      throw authError(404)
    result.revision = {
      fileId: locked.file,
      revision: row.revision.revision,
      sha256: row.revision.sha256,
      size: row.revision.size,
    }
  } else if (row.revision !== undefined) throw authError(404)
  return result
}
