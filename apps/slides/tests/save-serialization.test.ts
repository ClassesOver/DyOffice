import { describe, expect, it, vi } from 'vitest'

// file-actions pulls export-render → pptx-render → konva → native `canvas`
// (missing in CI). Mock the UI-only modules so this unit test exercises
// only the save-serialization queue.
vi.mock('../src/renderer/export-render', () => ({ renderSlidesToPngBase64: vi.fn() }))
vi.mock('../src/renderer/components/toast-bus', () => ({ showToast: vi.fn() }))
vi.mock('../src/renderer/i18n/locale', () => ({ t: (k: string) => k }))

import { adoptSavedSlides, save, saveAs } from '../src/renderer/file-actions'
import type { ActionCtx } from '../src/renderer/action-context'

function ctx(): ActionCtx {
  return {
    flushActiveEditRef: { current: () => Promise.resolve() },
    editingActiveRef: { current: false },
    flushNotes: () => Promise.resolve(),
    slides: [],
    current: 0,
    setSlides: () => {},
    setSelectedIds: () => {},
    setEnteredGroupId: () => {},
    setEditing: () => {},
    setEditingCell: () => {},
    setDirty: () => {},
    setPath: () => {},
    setStatus: () => {},
    path: '/test/deck.pptx',
  } as unknown as ActionCtx
}

describe('slides save serialization', () => {
  it('keeps the saved deck and clears stale selection when the current index is gone', () => {
    const slide = {
      widthPx: 960,
      heightPx: 540,
      scale: 1,
      background: { kind: 'solid', color: 'FFFFFF' },
      nodes: [],
    } as ActionCtx['slides'][number]
    for (const [slides, current, next] of [
      [[], 0, []],
      [[slide], 1, [slide]],
    ] as const) {
      const setSlides = vi.fn()
      const setSelectedIds = vi.fn()
      const setEditing = vi.fn()
      const setEditingCell = vi.fn()
      const context = {
        ...ctx(),
        slides,
        current,
        setSlides,
        setSelectedIds,
        setEnteredGroupId: vi.fn(),
        setEditing,
        setEditingCell,
      } as unknown as ActionCtx

      adoptSavedSlides(context, [...next])

      expect(setSlides).toHaveBeenCalledWith(next)
      expect(setSelectedIds.mock.calls[0]![0](['a', 'b'])).toEqual([])
      expect(setEditing.mock.calls[0]![0]({ sourceId: 'a' })).toBeNull()
      expect(setEditingCell.mock.calls[0]![0]({ sourceId: 'a', row: 0, col: 0 })).toBeNull()
    }
  })

  it('queues concurrent saves so only one IPC write runs at a time', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const mockSave = vi.fn(async () => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      // Simulate a slow write.
      await new Promise((resolve) => setTimeout(resolve, 50))
      inFlight -= 1
      return { ok: true }
    })
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })

    // Fire three saves simultaneously — they must queue, not overlap.
    const [a, b, c] = await Promise.all([save(ctx), save(ctx, true), save(ctx)])

    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(c).toBe(true)
    expect(mockSave).toHaveBeenCalledTimes(3)
    expect(maxConcurrent).toBe(1)

    vi.unstubAllGlobals()
  })

  it('serializes save against saveAs so their IPC writes never overlap', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const track = async () => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      // Simulate a slow write.
      await new Promise((resolve) => setTimeout(resolve, 50))
      inFlight -= 1
      return { ok: true }
    }
    const mockSave = vi.fn(track)
    const mockSaveAs = vi.fn(track)
    vi.stubGlobal('window', { slidesApi: { save: mockSave, saveAs: mockSaveAs } })

    // A manual save racing Save As (or close-save) must queue behind it.
    const [saved, _] = await Promise.all([save(ctx, true), saveAs(ctx)])

    expect(saved).toBe(true)
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSaveAs).toHaveBeenCalledTimes(1)
    expect(maxConcurrent).toBe(1)

    vi.unstubAllGlobals()
  })

  it('reports failure without blocking the queue for the next caller', async () => {
    let calls = 0
    const mockSave = vi.fn(async () => {
      calls += 1
      if (calls === 1) return { ok: false, error: 'disk full' }
      return { ok: true }
    })
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })

    const first = save(ctx, true)
    const second = save(ctx, true)
    const [r1, r2] = await Promise.all([first, second])

    expect(r1).toBe(false)
    expect(r2).toBe(true)
    expect(mockSave).toHaveBeenCalledTimes(2)

    vi.unstubAllGlobals()
  })

  it('resolves the context when a queued pass runs, not when it was queued', async () => {
    let saves = 0
    const mockSave = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      saves += 1
      return { ok: true }
    })
    vi.stubGlobal('window', { slidesApi: { save: mockSave } })

    const seen: number[] = []
    const getCtx = () => {
      seen.push(saves)
      return ctx()
    }
    await Promise.all([save(getCtx, true), save(getCtx, true)])

    expect(seen).toEqual([0, 1])

    vi.unstubAllGlobals()
  })
})

it('save waits for a blurred text commit even after focus moved to the save button', async () => {
  vi.useFakeTimers()
  const context = ctx(); context.editingActiveRef.current = true
  const write = vi.fn(async () => ({ok: true}))
  vi.stubGlobal('window', {slidesApi: {save: write}})
  const saving = save(() => context, true)
  try {
    await vi.advanceTimersByTimeAsync(100)
    expect(write).not.toHaveBeenCalled()
    context.editingActiveRef.current = false
    await vi.advanceTimersByTimeAsync(50)
    expect(await saving).toBe(true)
    expect(write).toHaveBeenCalledOnce()
  } finally {
    context.editingActiveRef.current = false
    await vi.runAllTimersAsync(); await saving
    vi.useRealTimers(); vi.unstubAllGlobals()
  }
})

it('save fails closed instead of writing while an edit remains pending after the wait bound', async () => {
  vi.useFakeTimers()
  const context = ctx(); context.editingActiveRef.current = true
  const write = vi.fn(async () => ({ok: true})), dirty = vi.fn(), status = vi.fn()
  context.setDirty = dirty; context.setStatus = status
  vi.stubGlobal('window', {slidesApi: {save: write}})
  try {
    const saving = save(() => context, true)
    await vi.advanceTimersByTimeAsync(2100)
    expect(await saving).toBe(false)
    expect(write).not.toHaveBeenCalled(); expect(dirty).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith('appEditCommitPending')
  } finally {vi.useRealTimers(); vi.unstubAllGlobals()}
})

it('save refuses the explicit two-second contenteditable flush timeout', async () => {
  vi.useFakeTimers()
  const context = ctx(); context.editingActiveRef.current = true
  const write = vi.fn(async () => ({ok: true})), blur = vi.fn()
  vi.stubGlobal('window', {slidesApi: {save: write}})
  vi.stubGlobal('document', {activeElement: {isContentEditable: true, blur}})
  try {
    const saving = save(() => context, true)
    await vi.advanceTimersByTimeAsync(2100)
    expect(blur).toHaveBeenCalledOnce()
    expect(await saving).toBe(false)
    expect(write).not.toHaveBeenCalled()
  } finally {vi.useRealTimers(); vi.unstubAllGlobals()}
})

it('timed-out Save As writes nothing and releases the save queue for a later retry', async () => {
  vi.useFakeTimers()
  const context = ctx(); context.editingActiveRef.current = true
  const write = vi.fn(async () => ({ok: true})), writeAs = vi.fn(async () => ({ok: true}))
  vi.stubGlobal('window', {slidesApi: {save: write, saveAs: writeAs}})
  try {
    const pending = saveAs(() => context)
    await vi.advanceTimersByTimeAsync(2100); await pending
    expect(writeAs).not.toHaveBeenCalled()
    context.editingActiveRef.current = false
    expect(await save(() => context, true)).toBe(true)
    expect(write).toHaveBeenCalledOnce()
  } finally {vi.useRealTimers();vi.unstubAllGlobals()}
})
