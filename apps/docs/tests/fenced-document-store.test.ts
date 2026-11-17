import { test, expect } from 'vitest'
import { act, createElement, Suspense, startTransition, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createDocumentMutationFence } from '../src/renderer/document-mutation-fence'
import * as storeModule from '../src/renderer/fenced-document-store'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test('field store invalidates before mutation and keeps field snapshots versioned independently', () => {
  expect(typeof storeModule.createFencedDocumentStore).toBe('function')
  const f = createDocumentMutationFence(),
    a = storeModule.createFencedDocumentStore(f, 'header', 0),
    b = storeModule.createFencedDocumentStore(f, 'comments', 0)
  a.set((prev) => {
    expect(f.snapshot().ready).toBe(false)
    return prev + 1
  })
  const first = a.getSnapshot()
  b.set(2)
  a.acknowledge(first.version)
  expect(f.snapshot().ready).toBe(false)
  b.acknowledge(b.getSnapshot().version)
  expect(f.snapshot().ready).toBe(true)
  expect(a.getSnapshot().value).toBe(1)
})
test('pending React transition cannot defer an external metadata snapshot that is acknowledged', async () => {
  const f = createDocumentMutationFence(),
    headerStore = storeModule.createFencedDocumentStore(f, 'header', 'old'),
    container = document.createElement('div'),
    root = createRoot(container)
  let setValue: ((value: string) => void) | undefined,
    setWait: ((value: boolean) => void) | undefined,
    release: () => void
  let blocked = true
  const waiting = new Promise<void>((r) => (release = r))
  function View() {
    const [value, set] = storeModule.useFencedDocumentStore(headerStore)
    const [wait, delay] = useState(false)
    setValue = set
    setWait = delay
    if (wait && blocked) throw waiting
    return createElement('p', null, value)
  }
  try {
    await act(async () =>
      root.render(
        createElement(
          Suspense,
          { fallback: createElement('p', null, 'pending') },
          createElement(View),
        ),
      ),
    )
    expect(f.snapshot().ready).toBe(true)
    await act(async () => {
      startTransition(() => setWait!(true))
    })
    await act(async () => {
      setValue!('new')
      expect(f.snapshot().ready).toBe(false)
    })
    expect(container.textContent).toBe('new')
    expect(f.snapshot().ready).toBe(true)
    blocked = false
    release!()
    await act(async () => await waiting)
    expect(container.textContent).toBe('new')
    expect(f.snapshot().ready).toBe(true)
  } finally {
    await act(async () => root.unmount())
  }
})
test('a truly suspended metadata render remains pending until its own snapshot commits', async () => {
  const f = createDocumentMutationFence(),
    headerStore = storeModule.createFencedDocumentStore(f, 'header', 'old'),
    container = document.createElement('div'),
    root = createRoot(container)
  let setValue: ((value: string) => void) | undefined,
    release: () => void,
    blocked = false
  const waiting = new Promise<void>((r) => (release = r))
  function View() {
    const [value, set] = storeModule.useFencedDocumentStore(headerStore)
    setValue = set
    if (blocked) throw waiting
    return createElement('p', null, value)
  }
  try {
    await act(async () =>
      root.render(
        createElement(
          Suspense,
          { fallback: createElement('p', null, 'pending') },
          createElement(View),
        ),
      ),
    )
    blocked = true
    await act(async () => {
      startTransition(() => setValue!('new'))
    })
    expect(f.snapshot().ready).toBe(false)
    blocked = false
    release!()
    await act(async () => await waiting)
    expect(container.textContent).toBe('new')
    expect(f.snapshot().ready).toBe(true)
  } finally {
    await act(async () => root.unmount())
  }
})
test('mutable package objects and out-of-band writes are not silently admitted', () => {
  const f = createDocumentMutationFence()
  expect(() => storeModule.createFencedDocumentStore(f, 'doc', new Map())).toThrow()
  const s = storeModule.createFencedDocumentStore(f, 'header', { text: 'a' })
  expect(() => {
    s.getSnapshot().value.text = 'changed'
  }).toThrow()
  expect(s.getSnapshot().value.text).toBe('a')
})
test('owner collisions and reserved editor ownership are rejected before a second store exists', () => {
  const f = createDocumentMutationFence()
  storeModule.createFencedDocumentStore(f, 'header', 0)
  expect(() => storeModule.createFencedDocumentStore(f, 'header', 1)).toThrow()
  expect(() => storeModule.createFencedDocumentStore(f, 'pm', 0)).toThrow()
})
test('StrictMode remount checks reuse host-owned field capabilities rather than registering during render', async () => {
  const { StrictMode } = await import('react')
  const f = createDocumentMutationFence(),
    store = storeModule.createFencedDocumentStore(f, 'header', 'old'),
    container = document.createElement('div'),
    root = createRoot(container)
  function View() {
    const [value] = storeModule.useFencedDocumentStore(store)
    return createElement('p', null, value)
  }
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(View))))
    await act(async () => store.set('new'))
    expect(container.textContent).toBe('new')
    expect(f.snapshot().ready).toBe(true)
  } finally {
    await act(async () => root.unmount())
  }
})
