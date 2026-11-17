import type { PoolClient } from 'pg'
import type { BusinessPrincipal, PrincipalTransactions } from '../../db/context.ts'
import { authorize } from '../policy/authorize.ts'
import { authError, tokenHash } from '../auth/sessions.ts'
import { scope, uuid } from '../files/queries.ts'
import type { LeaseRow } from '../leases/queries.ts'
import type { RealtimeCommandStatus, RealtimeCommandState, RealtimeLeaseState } from '../../../../../../packages/web-contracts/src/realtime.ts'

export interface RealtimeIdentity {
  readonly deploymentId: string
  readonly userId: string
  readonly sessionId: string
  readonly fileId: string
  readonly editorId: string | null
  readonly token: string
}
export type RealtimeSnapshot = Readonly<{ headRevision: string; lease: RealtimeLeaseState }>
/** Lock the file before resolving its head. A joined SELECT ... FOR SHARE can
 * retain the old joined revision when PostgreSQL waits for a concurrent commit
 * and EvalPlanQual replaces only the file tuple. The subsequent statement gets
 * a fresh READ COMMITTED snapshot while the file lock fences all head writers. */
export async function readRealtimeHead(connection: PoolClient, principal: BusinessPrincipal, fileId: string): Promise<string> {
  const values = [...scope(principal), uuid(fileId)]
  const locked = await connection.query('SELECT id FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND deleted_at IS NULL AND purge_started_at IS NULL FOR SHARE', values)
  if (!locked.rowCount) throw authError(404)
  const result = await connection.query<{ current_revision: string }>('SELECT current_revision FROM files WHERE deployment_id=$1 AND owner_id=$2 AND id=$3 AND deleted_at IS NULL AND purge_started_at IS NULL', values)
  if (!result.rows[0]) throw authError(404)
  return result.rows[0].current_revision
}
export const isCurrentEditor = (identity: Pick<RealtimeIdentity, 'editorId'>, lease: RealtimeLeaseState) =>
  identity.editorId !== null && lease.active && lease.heldByCurrentSession && lease.editorId === identity.editorId

/** No object downloads, separate lease transactions or caller-provided heads.
 * File SHARE lock also serializes lease writers (which lock the file first).
 * effect is synchronous so no async gap exists between the final session/time
 * check and queuing a frame. Principal locks remain held through that send. */
export function createRealtimeState({ transactions }: { transactions: PrincipalTransactions }) {
  return {
    withSnapshot<T>(identity: RealtimeIdentity, effect: (snapshot: RealtimeSnapshot, commands: readonly RealtimeCommandStatus[]) => T, commandIds: readonly string[] = []): Promise<T> {
      return transactions.withPrincipalTransaction({ kind: 'session', token: identity.token }, async (connection, principal) => {
        if (principal.deploymentId !== identity.deploymentId || principal.userId !== identity.userId || principal.sessionId !== identity.sessionId) throw authError()
        authorize(principal, 'files:read', { deploymentId: principal.deploymentId, ownerId: principal.userId })
        const headRevision = await readRealtimeHead(connection, principal, identity.fileId)
        const lease = (await connection.query<LeaseRow>('SELECT * FROM edit_leases WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 FOR SHARE', [...scope(principal), identity.fileId])).rows[0]
        const statuses = new Map<string, RealtimeCommandState>()
        if (commandIds.length) {
          const result = await connection.query<{ command_id: string; state: RealtimeCommandState }>('SELECT command_id,state FROM command_journal WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND file_id=$4 AND command_id=ANY($5::uuid[])', [...scope(principal), principal.sessionId, identity.fileId, commandIds])
          for (const row of result.rows) statuses.set(row.command_id, row.state)
        }
        // Re-authenticate after all reads/lock waits, immediately before sending.
        // The enclosing principal transaction also checks again before commit.
        const authority = await connection.query('SELECT * FROM lock_business_session($1::uuid,$2::text,$3::bigint)', [principal.deploymentId, tokenHash(identity.token), transactions.sessionIdleMs])
        if (!authority.rowCount) throw authError()
        const now: Date = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now
        const snapshot: RealtimeSnapshot = {
          headRevision,
          lease: lease ? {
            leaseEpoch: Number(lease.lease_epoch), editorId: lease.editor_id, expiresAt: lease.expires_at.toISOString(),
            active: lease.auth_version === principal.authVersion && lease.expires_at > now,
            heldByCurrentSession: lease.session_id === principal.sessionId && lease.job_id === null,
          } : { leaseEpoch: 0, editorId: null, expiresAt: null, active: false, heldByCurrentSession: false },
        }
        return effect(snapshot, commandIds.map(commandId => ({ commandId, state: statuses.get(commandId.toLowerCase()) ?? null })))
      })
    },
  }
}
export type RealtimeState = ReturnType<typeof createRealtimeState>
