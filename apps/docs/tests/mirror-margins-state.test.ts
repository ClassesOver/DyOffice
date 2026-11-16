import { test, expect } from 'vitest'
import { act, createElement, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createMirrorMarginsState, useMirrorMarginsState } from '../src/renderer/mirror-margins-state'

test('mirror-margins store synchronously exposes both inputs and rejects stale render acknowledgements', () => {
  const s = createMirrorMarginsState(),
    first = s.getSnapshot()
  s.markRendered(first.token)
  expect(s.getSaveState().ready).toBe(true)
  s.setEnabled(true)
  const color = s.getSnapshot()
  s.setDirty(true)
  expect(s.getSnapshot()).toMatchObject({ enabled: true, dirty: true })
  s.markRendered(color.token)
  expect(s.getSaveState().ready).toBe(false)
  s.markRendered(s.getSnapshot().token)
  expect(s.getSaveState().ready).toBe(true)
  s.setEnabled((old) => old)
  expect(s.getSaveState().ready).toBe(true)
  s.setDirty((old) => !old)
  expect(s.getSaveState().ready).toBe(false)
})

test('actual React suspended mirror-margins render remains pending until its own snapshot commits', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const element = document.createElement('div'),
    root = createRoot(element)
  let api!: ReturnType<typeof useMirrorMarginsState>,
    block = true,
    release!: () => void
  const wait = new Promise<void>((r) => (release = r))
  function View() {
    api = useMirrorMarginsState()
    if (api.mirrorMargins === true && block) throw wait
    return createElement('span', null, String(api.mirrorMargins))
  }
  try {
    await act(async () =>
      root.render(
        createElement(
          Suspense,
          { fallback: createElement('span', null, 'pending') },
          createElement(View),
        ),
      ),
    )
    expect(api.getMirrorMarginsSaveState().ready).toBe(true)
    await act(async () => {
      api.setMirrorMargins(true)
      api.setMirrorMarginsDirty(true)
    })
    expect(api.getMirrorMarginsSaveState().ready).toBe(false)
    block = false
    await act(async () => release())
    expect(api.mirrorMargins).toBe(true)
    expect(api.mirrorMarginsDirty).toBe(true)
    expect(api.getMirrorMarginsSaveState().ready).toBe(true)
  } finally {
    await act(async () => root.unmount())
    expect(api.getMirrorMarginsSaveState().ready).toBe(false)
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  }
})
