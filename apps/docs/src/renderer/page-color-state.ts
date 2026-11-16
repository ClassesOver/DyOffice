import { useLayoutEffect, useState, useSyncExternalStore, type SetStateAction } from 'react'

/** Only page color and its write-intent flag. Not a whole-document mutation fence.
 * Updates are synchronous so a pending React render cannot hide a save intent. */
export function createPageColorState() {
  let snapshot: Readonly<{ color: string | null; dirty: boolean; token: object }> = Object.freeze({
      color: null as string | null,
      dirty: false,
      token: {},
    }),
    rendered: object | undefined
  const listeners = new Set<() => void>()
  function update<K extends 'color' | 'dirty'>(
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
    setColor: (value: SetStateAction<string | null>) => update('color', value),
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

export function usePageColorState() {
  const [store] = useState(createPageColorState)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useLayoutEffect(() => {
    store.markRendered(state.token)
    return () => store.markUnrendered(state.token)
  }, [store, state.token])
  return {
    pageColor: state.color,
    pageColorDirty: state.dirty,
    setPageColor: store.setColor,
    setPageColorDirty: store.setDirty,
    getPageColorSaveState: store.getSaveState,
  }
}
