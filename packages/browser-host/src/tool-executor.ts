import type { CommandEnvelope } from '../../web-contracts/src/tools.ts'
export interface EditorCommandState {
  fileId: string
  baseRevision: string
  editorGeneration: number
  leaseEpoch: number
}
export interface ExecutionClaim {
  envelope: CommandEnvelope
  claimId: string
  appliedGeneration?: number
}
export interface CommandExecutionGate {
  /** Must commit an atomic, authenticated approved -> unknown_outcome transition before returning. */
  beginExecution(
    envelope: CommandEnvelope,
    digest: string,
  ): Promise<ExecutionClaim>
  reportApplied(
    envelope: CommandEnvelope,
    claimId: string,
    generation: number,
  ): Promise<unknown>
  beginUndo(envelope: CommandEnvelope): Promise<ExecutionClaim>
  reportUndone(envelope: CommandEnvelope, claimId: string): Promise<unknown>
}
export interface AtomicEditorTools {
  current(): EditorCommandState
  /** Trusted registry dispatch, validation and one synchronous atomic editor transaction.
   * No network, await, arbitrary script evaluation or generic undo stack calls.
   * Revalidate selection anchors inside the editor transaction. */
  applyBatch(envelope: CommandEnvelope): {
    generation: number
    undoToken: unknown
  }
  undoBatch(undoToken: unknown): number
}
export type ExecutionResult = {
  status: 'applied_uncommitted' | 'unknown_outcome' | 'conflict' | 'cancelled'
  commandId: string
}
/** No approval API: model output cannot approve itself. The gate is a trusted
 * authenticated server transport, not a model-provided implementation.
 * Does not save or claim committed: T06 durable receipt verification is separate.
 */
export function createToolExecutor({
  journal,
  editor,
}: {
  journal: CommandExecutionGate
  editor: AtomicEditorTools
}) {
  let disposed = false
  const inverses = new Map<string, { token: unknown; generation: number }>()
  function matches(e: CommandEnvelope, generation = e.editorGeneration) {
    if (disposed) return false
    const s = editor.current()
    return (
      s.fileId === e.fileId &&
      s.baseRevision === e.baseRevision &&
      s.leaseEpoch === e.leaseEpoch &&
      s.editorGeneration === generation
    )
  }
  const result = (
    e: CommandEnvelope,
    status: ExecutionResult['status'],
  ): ExecutionResult => ({ status, commandId: e.commandId })
  return {
    async executeAuthorizedTool(
      input: CommandEnvelope,
      digest: string,
    ): Promise<ExecutionResult> {
      if (disposed) throw new Error('Executor disposed')
      const e = structuredClone(input),
        claim = await journal.beginExecution(e, digest)
      if (claim.envelope.commandId !== e.commandId || !matches(claim.envelope))
        return result(e, 'conflict')
      // No await between final state check and the atomic editor operation.
      try {
        const applied = editor.applyBatch(claim.envelope)
        if (
          !Number.isSafeInteger(applied.generation) ||
          applied.generation <= e.editorGeneration ||
          !matches(e, applied.generation)
        )
          return result(e, 'unknown_outcome')
        inverses.set(e.commandId, {
          token: applied.undoToken,
          generation: applied.generation,
        })
        await journal.reportApplied(e, claim.claimId, applied.generation)
        return result(e, 'applied_uncommitted')
      } catch {
        return result(e, 'unknown_outcome')
      }
    },
    async undoCommand(input: CommandEnvelope): Promise<ExecutionResult> {
      if (disposed) throw new Error('Executor disposed')
      const e = structuredClone(input),
        inverse = inverses.get(e.commandId)
      if (!inverse) throw new Error('No local batch inverse; reconcile instead')
      if (!matches(e, inverse.generation)) return result(e, 'conflict')
      const claim = await journal.beginUndo(e)
      if (
        claim.envelope.commandId !== e.commandId ||
        claim.appliedGeneration !== inverse.generation ||
        !matches(e, inverse.generation)
      )
        return result(e, 'conflict')
      inverses.delete(e.commandId)
      try {
        const generation = editor.undoBatch(inverse.token)
        if (
          !Number.isSafeInteger(generation) ||
          generation <= inverse.generation ||
          !matches(e, generation)
        )
          return result(e, 'unknown_outcome')
        await journal.reportUndone(e, claim.claimId)
        return result(e, 'cancelled')
      } catch {
        return result(e, 'unknown_outcome')
      }
    },
    dispose() {
      disposed = true
      inverses.clear()
    },
  }
}
