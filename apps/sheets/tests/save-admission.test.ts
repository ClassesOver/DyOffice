import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSave, type SaveContext } from '../src/renderer/save-actions'
import {
  createEditJournal,
  journalSize,
  recordPageSetup,
  recordSetRangeValues,
  recordStructuralOp,
  recordVisualAdd,
} from '../src/renderer/edit-journal'
import { mutationAdmission } from '../src/renderer/mutation-admission'

vi.mock('../src/renderer/formula-settle', () => ({ settleFormulas: vi.fn(async () => {}) }))
const save = vi.fn()
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function setup(structural = true) {
  const journal = createEditJournal()
  recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'saved' } } })
  if (structural)
    recordStructuralOp(journal, 'sheet-1', { kind: 'insert-rows', index: 0, count: 1 })
  const state = {
    editJournal: journal,
    file: { sessionId: 'old', sha256: 'old', visuals: [], sheets: [] },
    flags: { preloadComplete: true },
    recalc: { overlay: new Map(), externalOverlay: new Map() },
  }
  const ref = { current: state }
  const open = vi.fn(async (file) => {
    ref.current = { ...state, file, editJournal: createEditJournal() }
    return true
  })
  const ctx = {
    univerRef: { current: null },
    lazyWorkbookRef: ref,
    setMessage: vi.fn(),
    setPendingEdits: vi.fn(),
    stashViewRestore: vi.fn(),
    openLazyWorkbook: open,
    applySavedWorkbook: vi.fn((file) => {
      state.file = file
    }),
  } as unknown as SaveContext
  return { ctx, state, journal, ref, open, gate: mutationAdmission(journal) }
}
beforeEach(() => {
  save
    .mockReset()
    .mockImplementation(async () => ({
      canceled: false,
      file: {
        sessionId: 'new',
        sha256: 'new',
        path: '/tmp/not-a-real-save.xlsx',
        visuals: [],
        sheets: [],
      },
    }))
  vi.stubGlobal('window', { desktopApi: { saveWorkbookEdits: save } })
})

describe('structural save admission', () => {
  it('drains an already-started direct chart write before taking the snapshot', async () => {
    const { ctx, gate, journal, open } = setup()
    const read = deferred()
    const task = gate.run(async () => {
      await read.promise
      recordVisualAdd(journal, {
        id: 'chart-pending',
        sheetId: 'sheet-1',
        kind: 'chart',
        anchor: { fromRow: 0, fromColumn: 0, toRow: 5, toColumn: 5 },
        chart: { chartTypes: ['barChart'], title: 'drained', series: [] },
      } as never)
    })
    const saving = handleSave(ctx, 'save')
    await vi.waitFor(() => expect(gate.phase).toBe('draining'))
    expect(save).not.toHaveBeenCalled()
    read.resolve()
    await task
    await expect(saving).resolves.toMatchObject({ ok: true })
    expect(save.mock.calls[0]?.[0].visualAdditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chart: expect.objectContaining({ title: 'drained' }) }),
      ]),
    )
    expect(open).toHaveBeenCalledTimes(1)
    expect(gate.phase).toBe('open')
  })

  it('blocks direct journal commits throughout IPC and reopen, then accepts the next edit/save', async () => {
    const { ctx, gate, journal, open, ref } = setup()
    save.mockImplementationOnce(async () => {
      expect(gate.phase).toBe('frozen')
      expect(() => recordPageSetup(journal, 'sheet-1', { zoomScale: 150 })).toThrow(/saving/i)
      return { canceled: false, file: { sessionId: 'new', sha256: 'new', visuals: [], sheets: [] } }
    })
    open.mockImplementationOnce(async (file) => {
      expect(gate.phase).toBe('frozen')
      ref.current = { ...ref.current, file, editJournal: createEditJournal() }
      return true
    })
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    expect(gate.phase).toBe('open')
    recordPageSetup(ref.current.editJournal, 'sheet-1', { zoomScale: 150 })
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0]).toMatchObject({ sessionId: 'new', structuralOps: [] })
  })

  it.each(['cancel', 'throw'] as const)(
    'releases admission on save %s without losing the original draft',
    async (failure) => {
      const { ctx, gate, journal } = setup()
      save.mockImplementationOnce(async () => {
        expect(gate.phase).toBe('frozen')
        if (failure === 'throw') throw new Error('network down')
        return { canceled: true }
      })
      await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: false })
      expect(gate.phase).toBe('open')
      expect(journalSize(journal)).toBeGreaterThan(0)
      recordPageSetup(journal, 'sheet-1', { zoomScale: 150 })
      await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    },
  )

  it('times out a stalled read before any save IPC and releases the UI phase', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, gate } = setup()
      const read = deferred()
      const task = gate.run(async () => await read.promise)
      const phases: string[] = []
      ctx.onMutationPhase = (phase) => {
        phases.push(phase)
      }
      const saving = handleSave(ctx, 'save')
      await vi.advanceTimersByTimeAsync(30_001)
      await expect(saving).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/timed out/i),
      })
      expect(save).not.toHaveBeenCalled()
      expect(phases).toEqual(['draining', 'open'])
      expect(gate.phase).toBe('open')
      read.resolve()
      await task
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a stuck save-owned flush and releases the lock before snapshot', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, gate } = setup()
      const flush = deferred()
      ctx.flushPendingChanges = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => flush.promise)
      const saving = handleSave(ctx, 'save')
      await vi.advanceTimersByTimeAsync(30_001)
      await expect(saving).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/timed out/i),
      })
      expect(save).not.toHaveBeenCalled()
      expect(gate.phase).toBe('open')
      flush.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not lock ordinary in-place saves and keeps late edits pending', async () => {
    const { ctx, gate, journal } = setup(false)
    save.mockImplementationOnce(async () => {
      expect(gate.phase).toBe('open')
      recordPageSetup(journal, 'sheet-1', { zoomScale: 150 })
      return { canceled: false, file: { sessionId: 'new', sha256: 'new', visuals: [], sheets: [] } }
    })
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    expect(journalSize(journal)).toBeGreaterThan(0)
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'new',
      pageSetupStates: [{ sheetId: 'sheet-1', zoomScale: 150 }],
    })
  })
})
