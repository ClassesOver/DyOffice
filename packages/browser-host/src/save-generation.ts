export type SaveOutcome = 'committed' | 'failed' | 'unknown'
export type SaveTicket = Readonly<{ generation: number }>
export type SaveGenerationState = Readonly<{
  generation: number
  savedGeneration: number
  dirty: boolean
  status: 'idle' | 'saving' | 'unknown'
}>

/** Local UI bookkeeping only. This does not commit bytes, grant a lease or enforce server CAS.
 * Call markEdited for every local/AI mutation; beginSave before serializing its snapshot.
 * Only a verified durable server commit (or reconciliation) may settle as committed.
 * A lost response is unknown, not failed: keep its ticket until reconciliation.
 */
export function createSaveGenerationGuard() {
  let generation = 0
  let savedGeneration = 0
  let pending: SaveTicket | null = null
  let status: SaveGenerationState['status'] = 'idle'
  return {
    markEdited(): void {
      if (generation === Number.MAX_SAFE_INTEGER) throw new Error('Edit generation exhausted')
      generation++
    },
    beginSave(): SaveTicket {
      if (pending) throw new Error('A save is already pending')
      pending = Object.freeze({ generation })
      status = 'saving'
      return pending
    },
    settleSave(ticket: SaveTicket, outcome: SaveOutcome): boolean {
      if (!pending || ticket !== pending) return false
      if (outcome === 'unknown') {
        status = 'unknown'
        return true
      }
      if (outcome !== 'committed' && outcome !== 'failed') throw new Error('Invalid save outcome')
      if (outcome === 'committed') savedGeneration = ticket.generation
      pending = null
      status = 'idle'
      return true
    },
    /** Call only after accepting an authoritative document snapshot, not to dismiss a conflict. */
    reset(): void {
      generation = savedGeneration = 0
      pending = null
      status = 'idle'
    },
    getState(): SaveGenerationState {
      return { generation, savedGeneration, dirty: generation !== savedGeneration, status }
    },
  }
}
