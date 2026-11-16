/** Host-owned clock; never recreate it merely because an editor/React component
 * remounts. Each asynchronous producer owns a unique, non-forgeable capability.
 * A PM notification cannot acknowledge a React/store/lifecycle owner's work. */
export function createDocumentMutationFence() {
  let generation = 0,
    disposed = false
  const names = new Set<string>(),
    pending = new Map<symbol, number>()
  function advance() {
    if (disposed) throw Error('Document fence disposed')
    if (generation >= Number.MAX_SAFE_INTEGER) {
      disposed = true
      throw Error('Document generation exhausted')
    }
    return ++generation
  }
  return {
    registerOwner(name: string) {
      if (disposed || !name || name.length > 128 || name === 'pm' || names.has(name))
        throw Error('Mutation owner must be unique and non-reserved')
      names.add(name)
      const owner = Symbol(name)
      return Object.freeze({
        invalidate() {
          const version = advance()
          pending.set(owner, version)
          return version
        },
        acknowledge(version: number) {
          if (disposed) return
          const waiting = pending.get(owner)
          if (waiting !== undefined && waiting <= version && version <= generation)
            pending.delete(owner)
        },
      })
    },
    // Called only after a synchronous editor state transition. This increments the
    // clock without clearing any asynchronous owner's pending token.
    recordEditorTransaction: advance,
    snapshot() {
      return { generation, ready: !disposed && pending.size === 0 }
    },
    dispose() {
      disposed = true
      pending.clear()
    },
  }
}
export type DocumentMutationFence = ReturnType<typeof createDocumentMutationFence>
