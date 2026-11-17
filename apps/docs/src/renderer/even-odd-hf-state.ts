import { useLayoutEffect, useState, useSyncExternalStore, type SetStateAction } from 'react'

/** Only even/odd headers and its write-intent flag. Not a whole-document mutation fence.
 * Updates are synchronous so a pending React render cannot hide a save intent. */
export function createEvenOddHfState() {
  let snapshot: Readonly<{ enabled: boolean; dirty: boolean; token: object }> = Object.freeze({
      enabled: false,
      dirty: false,
      token: {},
    }),
    rendered: object | undefined
  const listeners = new Set<() => void>()
  function update<K extends 'enabled' | 'dirty'>(
    key: K,
    value: SetStateAction<(typeof snapshot)[K]>,
  ) {
    const next = typeof value === 'function' ? value(snapshot[key]) : value
    if (Object.is(next, snapshot[key])) return
    snapshot = Object.freeze({ ...snapshot, [key]: next, token: {} })
    for (const notify of listeners) notify()
  }
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    setEnabled: (value: SetStateAction<boolean>) => update('enabled', value),
    setDirty: (value: SetStateAction<boolean>) => update('dirty', value),
    markRendered(token: object) {
      // An old commit can never acknowledge a newer synchronous input.
      if (token === snapshot.token) rendered = token
    },
    markUnrendered(token: object) {
      if (rendered === token) rendered = undefined
    },
    getSaveState: () => ({ token: snapshot.token, ready: rendered === snapshot.token }),
  })
}

export function useEvenOddHfState() {
  const [store] = useState(createEvenOddHfState)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useLayoutEffect(() => {
    store.markRendered(state.token)
    return () => store.markUnrendered(state.token)
  }, [store, state.token])
  return {
    evenOddHf: state.enabled,
    evenOddHfDirty: state.dirty,
    setEvenOddHf: store.setEnabled,
    setEvenOddHfDirty: store.setDirty,
    getEvenOddHfSaveState: store.getSaveState,
  }
}
