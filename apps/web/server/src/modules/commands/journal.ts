import type { CommandEnvelope } from '../../../../../../packages/web-contracts/src/tools.ts'
import type { RevisionRef } from '../../../../../../packages/web-contracts/src/api.ts'
export type CommandState =
  | 'pending_approval'
  | 'approved'
  | 'unknown_outcome'
  | 'applied_uncommitted'
  | 'committed'
  | 'cancelled'
export interface CommandRecord {
  envelope: CommandEnvelope
  digest: string
  policyHash: string
  state: CommandState
  approvedUntil?: number
  claimId?: string
  operation?: 'apply' | 'undo'
  appliedGeneration?: number
  revision?: RevisionRef
}
export interface CommandAuthority {
  deploymentId: string
  userId: string
  sessionId: string
  fileId: string
  baseRevision: string
  editorGeneration: number
  leaseEpoch: number
  scopes: readonly string[]
}
export interface AuthorizedCommandTransaction {
  /** Fresh authority derived from the authenticated session AFTER lock acquisition. */
  authority: CommandAuthority
  /** Database time captured after authority locks; optional only for synthetic adapters. */
  nowMs?: number
  /** Same transaction: verify a durable T06 receipt, including deployment/owner,
   * file/base/lease/command provenance and exact revision sha256/size. Merely
   * finding a revision belonging to this file is NOT sufficient evidence. */
  verifyCommit?: (record: CommandRecord, revision: RevisionRef) => Promise<boolean>
}
/** REQUIRED durable adapter; no memory fallback. The adapter owns authentication.
 * It derives deployment/user/session scope from a verified session (not arguments),
 * locks principal/account/file authority and the scoped command ID in canonical
 * order, then reads fresh authority and invokes update ONCE while holding locks.
 * Authorization remains valid through the atomic row update and commit. Commit
 * next before returning value; rollback callback failures. No external effects
 * inside update. Implement RLS and real lock-wait/restart tests before routes.
 */
export interface CommandJournal {
  withAuthorizedCommand<T>(
    fileId: string,
    id: string,
    update: (
      tx: AuthorizedCommandTransaction,
      current: CommandRecord | null,
    ) => Promise<{ next?: CommandRecord; value: T }>,
  ): Promise<T>
}
