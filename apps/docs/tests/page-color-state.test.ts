import { test, expect } from 'vitest'
import { act, createElement, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createPageColorState, usePageColorState } from '../src/renderer/page-color-state'

test('page-color store synchronously exposes both inputs and rejects stale render acknowledgements', () => {
  const s = createPageColorState(),
    first = s.getSnapshot()
  s.markRendered(first.token)
  expect(s.getSaveState().ready).toBe(true)
  s.setColor('FF0000')
  const color = s.getSnapshot()
  s.setDirty(true)
  expect(s.getSnapshot()).toMatchObject({ color: 'FF0000', dirty: true })
  s.markRendered(color.token)
  expect(s.getSaveState().ready).toBe(false)
  s.markRendered(s.getSnapshot().token)
  expect(s.getSaveState().ready).toBe(true)
  s.setColor((old) => old)
  expect(s.getSaveState().ready).toBe(true)
  s.setDirty((old) => !old)
  expect(s.getSaveState().ready).toBe(false)
})

test('actual React suspended page-color render remains pending until its own snapshot commits', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const element = document.createElement('div'),
    root = createRoot(element)
  let api!: ReturnType<typeof usePageColorState>,
    block = true,
    release!: () => void
  const wait = new Promise<void>((r) => (release = r))
  function View() {
    api = usePageColorState()
    if (api.pageColor === 'FF0000' && block) throw wait
    return createElement('span', null, api.pageColor ?? 'none')
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
    expect(api.getPageColorSaveState().ready).toBe(true)
    await act(async () => {
      api.setPageColor('FF0000')
      api.setPageColorDirty(true)
    })
    expect(api.getPageColorSaveState().ready).toBe(false)
    block = false
    await act(async () => release())
    expect(api.pageColor).toBe('FF0000')
    expect(api.pageColorDirty).toBe(true)
    expect(api.getPageColorSaveState().ready).toBe(true)
  } finally {
    await act(async () => root.unmount())
    expect(api.getPageColorSaveState().ready).toBe(false)
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT
  }
})
