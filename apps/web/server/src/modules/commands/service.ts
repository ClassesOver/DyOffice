import { randomUUID } from 'node:crypto'
import type {
  CommandEnvelope,
  ToolDescriptor,
} from '../../../../../../packages/web-contracts/src/tools.ts'
import {
  isRevisionRef,
  type RevisionRef,
} from '../../../../../../packages/web-contracts/src/api.ts'
import { commandError, commandHash, snapshotCommand, snapshotTool } from './approval.ts'
import type { CommandJournal, CommandRecord, AuthorizedCommandTransaction } from './journal.ts'
/** No HTTP boundary or independent authorization snapshot. The required journal
 * adapter authenticates and locks authority in the same transaction as each claim.
 * Real adapter/routes/editor/UI remain integration gates. */
export function createCommandService({
  journal,
  lookupTool,
  now = Date.now,
}: {
  journal: CommandJournal
  lookupTool: (name: string) => ToolDescriptor | undefined
  now?: () => number
}) {
  if (!journal?.withAuthorizedCommand || typeof lookupTool !== 'function')
    throw commandError('Authorized durable journal required')
  type View = {
    envelope: CommandEnvelope
    digest: string
    policyHash: string
    tx: AuthorizedCommandTransaction
  }
  async function run<T>(
    input: CommandEnvelope,
    live: boolean,
    operation: (
      view: View,
      current: CommandRecord | null,
    ) => Promise<{ next?: CommandRecord; value: T }> | { next?: CommandRecord; value: T },
  ): Promise<T> {
    const envelope = snapshotCommand(input)
    return journal.withAuthorizedCommand(
      envelope.fileId,
      envelope.commandId,
      async (tx, current) => {
        const a = tx.authority
        if (
          !a ||
          a.fileId !== envelope.fileId ||
          !a.deploymentId ||
          !a.userId ||
          !a.sessionId ||
          !a.scopes.includes('files:write')
        )
          throw commandError('Unauthorized command')
        const tool = snapshotTool(
          lookupTool(envelope.payload.toolName as string),
          envelope.payload.toolName as string,
        )
        if (tool.requiredScopes.some((s) => !a.scopes.includes(s)))
          throw commandError('Missing tool scope')
        if (
          live &&
          (a.baseRevision !== envelope.baseRevision ||
            a.editorGeneration !== envelope.editorGeneration ||
            a.leaseEpoch !== envelope.leaseEpoch)
        )
          throw commandError('Stale command authority')
        return operation(
          {
            envelope,
            tx,
            policyHash: commandHash(tool),
            digest: commandHash({ envelope, tool }),
          },
          current,
        )
      },
    )
  }
  function existing(current: CommandRecord | null, digest: string) {
    if (!current || current.digest !== digest) throw commandError('Command identity conflict')
    return current
  }
  return {
    proposeCommand(input: CommandEnvelope) {
      return run(input, true, (x, current) => {
        if (current) return { value: existing(current, x.digest) }
        const next: CommandRecord = {
          envelope: x.envelope,
          digest: x.digest,
          policyHash: x.policyHash,
          state: 'pending_approval',
        }
        return { next, value: next }
      })
    },
    approveCommand(input: CommandEnvelope, digest: string) {
      return run(input, true, (x, current) => {
        if (digest !== x.digest) throw commandError('Approval mismatch')
        const row = existing(current, digest)
        if (row.state !== 'pending_approval') throw commandError('Approval already decided')
        const next: CommandRecord = {
          ...row,
          state: 'approved',
          approvedUntil: (x.tx.nowMs ?? now()) + 60000,
        }
        return { next, value: next }
      })
    },
    beginExecution(input: CommandEnvelope, digest: string) {
      return run(input, true, (x, current) => {
        if (x.digest !== digest) throw commandError('Approval mismatch')
        const row = existing(current, digest)
        if (
          row.state !== 'approved' ||
          !row.approvedUntil ||
          row.approvedUntil <= (x.tx.nowMs ?? now())
        )
          throw commandError('Command cannot be dispatched')
        const next: CommandRecord = {
          ...row,
          state: 'unknown_outcome',
          operation: 'apply',
          claimId: randomUUID(),
        }
        return { next, value: next }
      })
    },
    reportApplied(input: CommandEnvelope, claimId: string, generation: number) {
      return run(input, false, (x, current) => {
        if (!Number.isSafeInteger(generation) || generation <= x.envelope.editorGeneration)
          throw commandError('Invalid applied generation')
        const row = existing(current, x.digest)
        if (row.state !== 'unknown_outcome' || row.operation !== 'apply' || row.claimId !== claimId)
          throw commandError('Invalid execution receipt')
        const next: CommandRecord = {
          ...row,
          state: 'applied_uncommitted',
          appliedGeneration: generation,
        }
        return { next, value: next }
      })
    },
    getCommandOutcome(input: CommandEnvelope) {
      return run(input, false, (x, current) => ({
        value: current ? existing(current, x.digest) : null,
      }))
    },
    cancelCommand(input: CommandEnvelope) {
      return run(input, false, (x, current) => {
        const row = existing(current, x.digest)
        if (!['pending_approval', 'approved'].includes(row.state)) return { value: row }
        const next: CommandRecord = { ...row, state: 'cancelled' }
        return { next, value: next }
      })
    },
    recordCommitted(input: CommandEnvelope, revision: RevisionRef) {
      const snapshot = structuredClone(revision)
      return run(input, false, async (x, current) => {
        if (
          !isRevisionRef(snapshot) ||
          snapshot.fileId !== x.envelope.fileId ||
          snapshot.revision === x.envelope.baseRevision ||
          !x.tx.verifyCommit
        )
          throw commandError('Invalid commit receipt')
        const row = existing(current, x.digest)
        if (row.state === 'committed') {
          if (commandHash(row.revision) !== commandHash(snapshot))
            throw commandError('Commit receipt conflict')
          return { value: row }
        }
        if (
          !['unknown_outcome', 'applied_uncommitted'].includes(row.state) ||
          row.operation !== 'apply' ||
          !(await x.tx.verifyCommit(structuredClone(row), snapshot))
        )
          throw commandError('Unverified commit receipt')
        const next: CommandRecord = {
          ...row,
          state: 'committed',
          revision: snapshot,
        }
        return { next, value: next }
      })
    },
    beginUndo(input: CommandEnvelope) {
      return run(input, false, (x, current) => {
        const row = existing(current, x.digest),
          a = x.tx.authority
        if (
          row.state !== 'applied_uncommitted' ||
          a.baseRevision !== x.envelope.baseRevision ||
          a.leaseEpoch !== x.envelope.leaseEpoch ||
          a.editorGeneration !== row.appliedGeneration
        )
          throw commandError('Newer edits or save block undo')
        const next: CommandRecord = {
          ...row,
          state: 'unknown_outcome',
          operation: 'undo',
          claimId: randomUUID(),
        }
        return { next, value: next }
      })
    },
    reportUndone(input: CommandEnvelope, claimId: string) {
      return run(input, false, (x, current) => {
        const row = existing(current, x.digest)
        if (row.state !== 'unknown_outcome' || row.operation !== 'undo' || row.claimId !== claimId)
          throw commandError('Invalid undo receipt')
        const next: CommandRecord = { ...row, state: 'cancelled' }
        return { next, value: next }
      })
    },
  }
}
