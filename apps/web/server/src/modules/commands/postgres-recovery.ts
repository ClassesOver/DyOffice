import type { PrincipalTransactions } from '../../db/context.ts'
import { withLockedRecoveryCommand, projectRecoveryCommand } from './postgres-recovery-private.ts'
export type { RecoveredCommand } from './postgres-recovery-private.ts'
/** Read-only ID recovery. No editor/lease input, writes, cleanup or capability. */
export function createPostgresCommandRecovery({
  transactions,
  token,
}: {
  transactions: PrincipalTransactions
  token: string
}) {
  return Object.freeze({
    lookup: (fileId: string, commandId: string) =>
      withLockedRecoveryCommand(transactions, token, fileId, commandId, (locked) =>
        projectRecoveryCommand(locked),
      ),
  })
}
