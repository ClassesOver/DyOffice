import type { PoolClient } from 'pg'
import type { PrincipalTransactions, BusinessPrincipal } from '../../db/context.ts'
import type { RevisionRef } from '../../../../../../packages/web-contracts/src/api.ts'
import { authorize } from '../policy/authorize.ts'
import { authError } from '../auth/sessions.ts'
import { lockAccount, loadFile, scope, uuid } from '../files/queries.ts'
import { lockLease, databaseTime, assertLiveLease } from '../leases/queries.ts'
import type { CommandJournal, CommandRecord, AuthorizedCommandTransaction } from './journal.ts'
import { canonicalCommandJson, commandError } from './approval.ts'

export interface CommandUploadBinding {
  commandId: string
  fileId: string
  digest: string
  uploadId: string
  sha256: string
  size: number
  idempotencyKey: string
}
/** Unmounted adapter: construct per authenticated request. editorGeneration is a
 * browser precondition, NOT server evidence of current selection state. The
 * BrowserHost must still compare-and-apply synchronously after receiving a claim.
 * DB authority (session/owner/file head/editor lease) is read under DB locks.
 */
export function createPostgresCommandJournal({
  transactions,
  token,
  editorId,
  editorGeneration,
}: {
  transactions: PrincipalTransactions
  token: string
  editorId: string
  editorGeneration: number
}) {
  const editor = uuid(editorId),
    credential = Object.freeze({ kind: 'session' as const, token })
  if (!Number.isSafeInteger(editorGeneration) || editorGeneration < 0) throw authError(400)
  async function receipt(
    c: PoolClient,
    p: BusinessPrincipal,
    record: CommandRecord,
    revision: RevisionRef,
  ) {
    const e = record.envelope
    const found = await c.query(
      `SELECT 1 FROM command_upload_bindings b
    JOIN revision_commits rc ON rc.deployment_id=b.deployment_id AND rc.owner_id=b.owner_id AND rc.file_id=b.file_id AND rc.upload_id=b.upload_id AND rc.idempotency_key=b.idempotency_key
    JOIN uploads u ON u.deployment_id=b.deployment_id AND u.owner_id=b.owner_id AND u.file_id=b.file_id AND u.id=b.upload_id
    JOIN file_revisions r ON r.deployment_id=rc.deployment_id AND r.owner_id=rc.owner_id AND r.file_id=rc.file_id AND r.id=rc.revision_id
    WHERE b.deployment_id=$1 AND b.owner_id=$2 AND b.session_id=$3 AND b.command_id=$4 AND b.file_id=$5
     AND rc.requested_source_command_id=b.command_id AND rc.base_revision=$6 AND rc.lease_epoch=$7 AND rc.job_id IS NULL
     AND u.session_id=b.session_id AND u.editor_id=b.editor_id AND b.editor_id=$8 AND u.base_revision=rc.base_revision AND u.lease_epoch=rc.lease_epoch AND u.state='committed'
     AND u.sha256=b.sha256 AND u.expected_size=b.size AND r.source='save' AND r.parent_revision=rc.base_revision
     AND r.id=$9 AND r.sha256=$10 AND r.size=$11 AND r.sha256=b.sha256 AND r.size=b.size`,
      [
        ...scope(p),
        p.sessionId,
        e.commandId,
        e.fileId,
        e.baseRevision,
        e.leaseEpoch,
        editor,
        revision.revision,
        revision.sha256,
        revision.size,
      ],
    )
    return found.rowCount === 1
  }
  async function locked<T>(
    fileId: string,
    commandId: string,
    fn: (
      c: PoolClient,
      p: BusinessPrincipal,
      tx: AuthorizedCommandTransaction,
      current: CommandRecord | null,
    ) => Promise<T>,
  ): Promise<T> {
    const file = uuid(fileId),
      id = uuid(commandId)
    if (file !== fileId || id !== commandId) throw authError(400)
    return transactions.withPrincipalTransaction(credential, async (c, p) => {
      authorize(p, 'files:write', { deploymentId: p.deploymentId, ownerId: p.userId })
      if (p.job) throw authError(404)
      // Match publication/purge lock order. Account lock serializes absent command
      // rows too, so competing first proposals cannot both create a command ID.
      await lockAccount(c, p)
      const currentFile = await loadFile(c, p, file, true, 'UPDATE')
      const lease = await lockLease(c, p, file),
        now = await databaseTime(c)
      const live =
        lease &&
        lease.job_id === null &&
        lease.session_id === p.sessionId &&
        lease.auth_version === p.authVersion &&
        lease.editor_id === editor &&
        lease.expires_at > now
      const row = (
        await c.query<{ record: CommandRecord }>(
          'SELECT record FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4 FOR UPDATE',
          [...scope(p), p.sessionId, id],
        )
      ).rows[0]
      if (row && row.record.envelope.fileId !== file)
        throw commandError('Command file identity conflict')
      const tx: AuthorizedCommandTransaction = {
        authority: {
          deploymentId: p.deploymentId,
          userId: p.userId,
          sessionId: p.sessionId,
          fileId: file,
          baseRevision: currentFile.current_revision,
          editorGeneration,
          leaseEpoch: live ? Number(lease.lease_epoch) : 0,
          scopes: p.scopes,
        },
        nowMs: now.getTime(),
        verifyCommit: (record, revision) => receipt(c, p, record, revision),
      }
      return fn(c, p, tx, row?.record ?? null)
    })
  }
  const journal: CommandJournal = {
    withAuthorizedCommand(fileId, id, update) {
      return locked(fileId, id, async (c, p, tx, current) => {
        const changed = await update(tx, current ? structuredClone(current) : null)
        if (changed.next) {
          const next = changed.next
          if (next.envelope.fileId !== fileId || next.envelope.commandId !== id)
            throw commandError('Journal identity mismatch')
          const json = canonicalCommandJson(next)
          if (current) {
            await c.query(
              'UPDATE command_journal SET record=$5::jsonb,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4',
              [...scope(p), p.sessionId, id, json],
            )
          } else {
            await c.query(
              'INSERT INTO command_journal(deployment_id,owner_id,session_id,command_id,file_id,record) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
              [...scope(p), p.sessionId, id, fileId, json],
            )
          }
          // Locks cannot stop time. Recheck the DB deadline after writes for any new
          // approval/dispatch; receipt/outcome recording survives lease expiry.
          if (['pending_approval', 'approved', 'unknown_outcome'].includes(next.state))
            await assertLiveLease(c, p, fileId, next.envelope.leaseEpoch, editor)
        }
        return structuredClone(changed.value)
      })
    },
  }
  return {
    ...journal,
    bindCommandUpload(input: CommandUploadBinding) {
      const value = JSON.parse(canonicalCommandJson(input)) as CommandUploadBinding
      if (
        Object.keys(value).sort().join(',') !==
          'commandId,digest,fileId,idempotencyKey,sha256,size,uploadId' ||
        !/^[a-f0-9]{64}$/.test(value.digest) ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        !Number.isSafeInteger(value.size) ||
        value.size < 1 ||
        value.size > 33554432 ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(value.idempotencyKey)
      )
        throw authError(400)
      const upload = uuid(value.uploadId)
      return locked(value.fileId, value.commandId, async (c, p, tx, row) => {
        if (
          !row ||
          row.digest !== value.digest ||
          row.state !== 'applied_uncommitted' ||
          row.appliedGeneration !== tx.authority.editorGeneration ||
          row.envelope.baseRevision !== tx.authority.baseRevision ||
          row.envelope.leaseEpoch !== tx.authority.leaseEpoch
        )
          throw commandError('Save binding requires current applied command')
        const u = (
          await c.query(
            'SELECT * FROM uploads WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE',
            [...scope(p), upload],
          )
        ).rows[0]
        if (
          !u ||
          u.file_id !== value.fileId ||
          u.kind !== 'revision' ||
          u.state !== 'ready' ||
          u.session_id !== p.sessionId ||
          u.editor_id !== editor ||
          u.base_revision !== row.envelope.baseRevision ||
          Number(u.lease_epoch) !== row.envelope.leaseEpoch ||
          u.sha256 !== value.sha256 ||
          u.expected_size !== value.size ||
          u.restored_from !== null
        )
          throw commandError('Upload does not match command save intent')
        const prior = (
          await c.query(
            'SELECT upload_id,sha256,size,idempotency_key FROM command_upload_bindings WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4',
            [...scope(p), p.sessionId, value.commandId],
          )
        ).rows[0]
        if (prior) {
          if (
            prior.upload_id !== upload ||
            prior.sha256 !== value.sha256 ||
            prior.size !== value.size ||
            prior.idempotency_key !== value.idempotencyKey
          )
            throw commandError('Command save intent is immutable')
        } else
          await c.query(
            'INSERT INTO command_upload_bindings(deployment_id,owner_id,session_id,command_id,file_id,upload_id,sha256,size,idempotency_key,editor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [
              ...scope(p),
              p.sessionId,
              value.commandId,
              value.fileId,
              upload,
              value.sha256,
              value.size,
              value.idempotencyKey,
              editor,
            ],
          )
        await assertLiveLease(c, p, value.fileId, row.envelope.leaseEpoch, editor)
        return { bound: true as const }
      })
    },
  }
}
