import { test, expect } from 'vitest'
import { act, createElement, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createEvenOddHfState, useEvenOddHfState } from '../src/renderer/even-odd-hf-state'

test('even-odd-hf store synchronously exposes both inputs and rejects stale render acknowledgements', () => {
  const s = createEvenOddHfState(),
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

test('actual React suspended even-odd-hf render remains pending until its own snapshot commits', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const element = document.createElement('div'),
    root = createRoot(element)
  let api!: ReturnType<typeof useEvenOddHfState>,
    block = true,
    release!: () => void
  const wait = new Promise<void>((r) => (release = r))
  function View() {
    api = useEvenOddHfState()
    if (api.evenOddHf === true && block) throw wait
    return createElement('span', null, String(api.evenOddHf))
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
    expect(api.getEvenOddHfSaveState().ready).toBe(true)
    await act(async () => {
      api.setEvenOddHf(true)
      api.setEvenOddHfDirty(true)
    })
    expect(api.getEvenOddHfSaveState().ready).toBe(false)
    block = false
    await act(async () => release())
    expect(api.evenOddHf).toBe(true)
    expect(api.evenOddHfDirty).toBe(true)
    expect(api.getEvenOddHfSaveState().ready).toBe(true)
  } finally {
    await act(async () => root.unmount())
    expect(api.getEvenOddHfSaveState().ready).toBe(false)
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  }
})
