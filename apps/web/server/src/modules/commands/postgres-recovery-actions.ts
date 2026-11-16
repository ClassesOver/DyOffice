import type { PrincipalTransactions } from '../../db/context.ts'
import type { ToolDescriptor } from '../../../../../../packages/web-contracts/src/tools.ts'
import { authError } from '../auth/sessions.ts'
import { scope } from '../files/queries.ts'
import { canonicalCommandJson, commandError } from './approval.ts'
import type { CommandJournal } from './journal.ts'
import { createCommandService } from './service.ts'
import {
  withLockedRecoveryCommand,
  verifyLockedRecoveryCommit,
  projectRecoveryCommand,
} from './postgres-recovery-private.ts'
/** Explicit fencing only, not execution/undo/lease restoration. The server must
 * supply its fixed trusted registry; no caller envelope, editor or tool policy. */
export function createPostgresCommandRecoveryActions({
  transactions,
  token,
  lookupTool,
}: {
  transactions: PrincipalTransactions
  token: string
  lookupTool: (name: string) => ToolDescriptor | undefined
}) {
  if (typeof lookupTool !== 'function') throw commandError('Trusted registry required')
  return Object.freeze({
    async abandon(fileId: string, commandId: string, observedDigest: string) {
      if (typeof observedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(observedDigest))
        throw authError(400)
      return withLockedRecoveryCommand(transactions, token, fileId, commandId, async (locked) => {
        let used = false,
          active = true,
          current = structuredClone(locked.record)
        // Private single-use adapter, bound to exactly the locked row and transaction.
        // Never exported, cached, or passed to a generic browser dispatcher.
        const journal: CommandJournal = {
          async withAuthorizedCommand(file, id, update) {
            if (!active || used || file !== locked.file || id !== locked.id)
              throw commandError('Recovery adapter cannot be reused')
            used = true
            const changed = await update(
              {
                authority: {
                  deploymentId: locked.p.deploymentId,
                  userId: locked.p.userId,
                  sessionId: locked.p.sessionId,
                  fileId: locked.file,
                  baseRevision: locked.baseRevision,
                  leaseEpoch: 0,
                  editorGeneration: 0,
                  scopes: locked.p.scopes,
                },
                verifyCommit: (record, revision) =>
                  verifyLockedRecoveryCommit(locked, record, revision),
              },
              structuredClone(locked.record),
            )
            if (changed.next) {
              const next = changed.next
              if (
                next.state !== 'abandoned_uncommitted' ||
                ![
                  'pending_approval',
                  'approved',
                  'unknown_outcome',
                  'applied_uncommitted',
                ].includes(locked.record.state) ||
                canonicalCommandJson({ ...next, state: locked.record.state }) !==
                  canonicalCommandJson(locked.record)
              )
                throw commandError('Recovery may only fence the unchanged command')
              const saved = await locked.c.query(
                'UPDATE command_journal SET record=$6::jsonb,updated_at=clock_timestamp() WHERE deployment_id=$1 AND owner_id=$2 AND session_id=$3 AND command_id=$4 AND record=$5::jsonb AND file_id=$7',
                [
                  ...scope(locked.p),
                  locked.p.sessionId,
                  locked.id,
                  canonicalCommandJson(locked.record),
                  canonicalCommandJson(next),
                  locked.file,
                ],
              )
              if (saved.rowCount !== 1) throw commandError('Recovery command changed')
              current = structuredClone(next)
            }
            return changed.value
          },
        }
        try {
          const result = await createCommandService({ journal, lookupTool }).abandonCommand(
            structuredClone(locked.record.envelope),
            observedDigest,
          )
          if (!used || canonicalCommandJson(result) !== canonicalCommandJson(current))
            throw commandError('Recovery result mismatch')
          return await projectRecoveryCommand(locked, current)
        } finally {
          active = false
        }
      })
    },
  })
}
