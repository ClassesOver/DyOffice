import { useLayoutEffect, useSyncExternalStore, type SetStateAction } from 'react'
import type { DocumentMutationFence } from './document-mutation-fence'
/** Experimental JSON metadata store. No App migration/activation yet. Maps,
 * parsed package models, binary parts and other mutable external objects are
 * deliberately unsupported until they have an explicit ownership contract. */
function immutable<T>(input: T): T {
  let count = 0
  function copy(v: unknown, depth: number): unknown {
    if (++count > 100000 || depth > 32) throw Error('Metadata snapshot exceeds bounds')
    if (
      v === null ||
      v === undefined ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return v
    if (!v || typeof v !== 'object' || Object.getOwnPropertySymbols(v).length)
      throw Error('Unsupported metadata value')
    const proto = Object.getPrototypeOf(v)
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null)
      throw Error('Unsupported metadata ownership')
    const descriptors = Object.getOwnPropertyDescriptors(v)
    for (const [key, d] of Object.entries(descriptors))
      if (key !== 'length' && (!('value' in d) || !d.enumerable))
        throw Error('Metadata accessors forbidden')
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw Error('Sparse metadata array')
      return Object.freeze(v.map((x) => copy(x, depth + 1)))
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(descriptors).map(([k, d]) => [k, copy(d.value, depth + 1)]),
      ),
    )
  }
  return copy(input, 0) as T
}
export function createFencedDocumentStore<T>(
  fence: DocumentMutationFence,
  owner: string,
  initial: T,
) {
  const capability = fence.registerOwner(owner)
  let state = Object.freeze({ value: immutable(initial), version: 0 }),
    setting = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    acknowledge: capability.acknowledge,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(action: SetStateAction<T>) {
      if (setting) throw Error('Reentrant metadata mutation')
      setting = true
      const version = capability.invalidate()
      try {
        const value = immutable(
          typeof action === 'function' ? (action as (previous: T) => T)(state.value) : action,
        )
        state = Object.freeze({ value, version })
        for (const listener of listeners) listener()
      } finally {
        setting = false
      }
    },
  }
}
/** The host creates stores OUTSIDE React render. This prevents StrictMode or a
 * discarded concurrent render from registering duplicate field owners. */
export function useFencedDocumentStore<T>(
  store: ReturnType<typeof createFencedDocumentStore<T>>,
): [T, (action: SetStateAction<T>) => void] {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useLayoutEffect(() => {
    store.acknowledge(snapshot.version)
  }, [store, snapshot.version])
  return [snapshot.value, store.set]
}
