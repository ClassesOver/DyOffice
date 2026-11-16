import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSave, type SaveContext } from '../src/renderer/save-actions'
import {
  acknowledgeJournal,
  createEditJournal,
  journalSize,
  recordChartEdit,
  recordFilterChange,
  recordPageSetup,
  recordSetRangeValues,
  recordSheetTabColor,
  recordStructuralOp,
  snapshotJournal,
} from '../src/renderer/edit-journal'

const settle = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../src/renderer/formula-settle', () => ({ settleFormulas: settle }))
const save = vi.fn()
function setup(inPlace = true) {
  const journal = createEditJournal()
  recordSetRangeValues(journal, 'sheet-1', { 0: { 0: { v: 'saved' } } })
  const state = {
    editJournal: journal,
    file: { sessionId: 'old', sha256: 'old', visuals: [], sheets: [] },
    flags: { preloadComplete: true },
    recalc: { overlay: new Map(), externalOverlay: new Map() },
  }
  const ref = { current: state }
  const applySavedWorkbook = vi.fn((file) => {
    state.file = { ...file, visuals: state.file.visuals, sheets: state.file.sheets }
  })
  const openLazyWorkbook = vi.fn(async (file) => {
    ref.current = { ...state, file, editJournal: createEditJournal() }
    return true
  })
  const ctx = {
    univerRef: { current: null },
    lazyWorkbookRef: ref,
    openLazyWorkbook,
    setMessage: vi.fn(),
    setPendingEdits: vi.fn(),
    stashViewRestore: vi.fn(),
    ...(inPlace ? { applySavedWorkbook } : {}),
  } as unknown as SaveContext
  return { state, journal, ctx, applySavedWorkbook, openLazyWorkbook, ref }
}
beforeEach(() => {
  settle.mockReset().mockResolvedValue(undefined)
  save.mockReset().mockResolvedValue({
    canceled: false,
    file: { sessionId: 'new', sha256: 'new', path: '/tmp/a.xlsx', visuals: [], sheets: [] },
  })
  vi.stubGlobal('window', { desktopApi: { saveWorkbookEdits: save } })
})

describe('T09 in-place save acknowledgment', () => {
  it('tracks repeated declarative edits and exposes them after a save acknowledgment', () => {
    const journal = createEditJournal()
    recordFilterChange(journal, 'sheet-1')
    const saved = snapshotJournal(journal)
    acknowledgeJournal(journal, saved)
    expect(journalSize(journal)).toBe(0)
    recordFilterChange(journal, 'sheet-1')
    expect(journalSize(journal)).toBeGreaterThan(0)
  })
  it('keeps the runtime and acknowledges only the sent edits, then skips clean autosave', async () => {
    const { ctx, journal, applySavedWorkbook, openLazyWorkbook } = setup()
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    expect(applySavedWorkbook).toHaveBeenCalledTimes(1)
    expect(openLazyWorkbook).not.toHaveBeenCalled()
    expect(journalSize(journal)).toBe(0)
    await expect(handleSave(ctx, 'save', true)).resolves.toMatchObject({ reason: 'no-edits' })
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('keeps late cell, chart and page edits pending for a second save against the new session', async () => {
    const { ctx, journal, state } = setup()
    save.mockImplementationOnce(async () => {
      recordSetRangeValues(journal, 'sheet-1', { 1: { 0: { v: 'late' } } })
      recordChartEdit(journal, 'xl/charts/chart1.xml', { title: 'late title' })
      recordPageSetup(journal, 'sheet-1', { zoomScale: 130 })
      return { canceled: false, file: { ...state.file, sessionId: 'new', sha256: 'new' } }
    })
    await handleSave(ctx, 'save')
    expect(journalSize(journal)).toBe(3)
    await handleSave(ctx, 'save', true)
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'new',
        chartEdits: [{ chartPath: 'xl/charts/chart1.xml', title: 'late title' }],
        pageSetupStates: [{ sheetId: 'sheet-1', zoomScale: 130 }],
      }),
    )
    expect(journalSize(journal)).toBe(0)
  })
  it('retains the desktop reopen contract when no callback is supplied', async () => {
    const { ctx, openLazyWorkbook } = setup(false)
    await handleSave(ctx, 'save')
    expect(openLazyWorkbook).toHaveBeenCalledTimes(1)
  })
  it('settles formulas and awaits chart flush before taking any journal snapshot', async () => {
    const { ctx, journal } = setup()
    settle.mockImplementation(async () => {
      recordSetRangeValues(journal, 'sheet-1', { 2: { 0: { v: 'settled' } } })
    })
    const flush = vi.fn(async () => {
      expect(settle).toHaveBeenCalled()
      recordChartEdit(journal, 'xl/charts/chart1.xml', { series: [{ index: 0, values: [42] }] })
    })
    Object.assign(ctx, { flushPendingChanges: flush })
    await handleSave(ctx, 'save')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      edits: expect.arrayContaining([expect.objectContaining({ row: 2, value: 'settled' })]),
      chartEdits: [{ chartPath: 'xl/charts/chart1.xml', series: [{ index: 0, values: [42] }] }],
    })
  })
  it('saves undo back to the original chart title and visual anchor after acknowledgment', async () => {
    const { ctx, journal, state } = setup()
    const visual = {
      id: 'chart-1',
      sheetId: 'sheet-1',
      kind: 'chart',
      chartPath: 'xl/charts/chart1.xml',
      drawingPath: 'xl/drawings/drawing1.xml',
      drawingIndex: 0,
      anchor: { fromRow: 0, toRow: 5, fromColumn: 0, toColumn: 5 },
      chart: { chartTypes: ['barChart'], title: 'original', series: [] },
    }
    state.file.visuals = [visual] as never
    recordChartEdit(journal, visual.chartPath, { title: 'edited' })
    journal.visualEdits.set(visual.id, {
      sheetId: visual.sheetId,
      drawingPath: visual.drawingPath,
      drawingIndex: 0,
      anchor: { ...visual.anchor, fromRow: 7, toRow: 12 },
    } as never)
    await handleSave(ctx, 'save')
    journal.chartEdits.delete(visual.chartPath)
    journal.visualEdits.delete(visual.id)
    await handleSave(ctx, 'save')
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      chartEdits: [{ chartPath: visual.chartPath, title: 'original' }],
      visualEdits: [expect.objectContaining({ anchor: visual.anchor })],
    })
    expect(journalSize(journal)).toBe(0)
  })
  it('reopens for tab-color edits rather than acknowledging an irreversible sheet delta in place', async () => {
    const { ctx, journal, applySavedWorkbook, openLazyWorkbook } = setup()
    const sheet = { getSheetId: () => 'sheet-1' }
    const workbook = {
      getActiveSheet: () => sheet,
      getActiveRange: () => null,
      getSheets: () => [sheet],
    }
    Object.assign(ctx.univerRef, { current: { univerAPI: { getActiveWorkbook: () => workbook } } })
    recordSheetTabColor(journal, 'sheet-1', '#FF0000', null)
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetOps: [{ kind: 'set-sheet-tab-color', sheetId: 'sheet-1', color: '#FF0000' }],
      }),
    )
    expect(applySavedWorkbook).not.toHaveBeenCalled()
    expect(openLazyWorkbook).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      baseline: {},
      currentAxis: { min: 10 },
      currentTitles: { category: 'kept' },
      expectedAxis: { min: 10, max: null },
      expectedTitles: { category: 'kept', value: null },
    },
    {
      baseline: {},
      currentAxis: { min: 10, max: undefined },
      currentTitles: { category: 'kept', value: undefined },
      expectedAxis: { min: 10, max: null },
      expectedTitles: { category: 'kept', value: null },
    },
    {
      baseline: {
        valueAxis: { min: 2, max: 70 },
        axisTitles: { category: 'original category', value: 'original value' },
      },
      currentAxis: { max: 100 },
      currentTitles: { value: 'kept' },
      expectedAxis: { min: 2, max: 100 },
      expectedTitles: { category: 'original category', value: 'kept' },
    },
  ])(
    'restores missing axis keys during a partial undo: $expectedAxis',
    async ({ baseline, currentAxis, currentTitles, expectedAxis, expectedTitles }) => {
      const { ctx, journal, state, openLazyWorkbook } = setup()
      const path = 'xl/charts/chart1.xml'
      state.file.visuals = [
        {
          id: 'chart-1',
          sheetId: 'sheet-1',
          kind: 'chart',
          chartPath: path,
          chart: { chartTypes: ['barChart'], title: 'original', series: [], ...baseline },
        },
      ] as never
      recordChartEdit(journal, path, {
        valueAxis: { min: 10, max: 100 },
        axisTitles: { category: 'kept', value: 'edited' },
      })
      await handleSave(ctx, 'save')
      // An undo snapshot restores only one axis field, not the whole object.
      journal.chartEdits.set(path, { valueAxis: currentAxis, axisTitles: currentTitles })
      await handleSave(ctx, 'save')
      expect(save.mock.calls[1]?.[0]).toMatchObject({
        chartEdits: [{ chartPath: path, valueAxis: expectedAxis, axisTitles: expectedTitles }],
      })
      expect(openLazyWorkbook).not.toHaveBeenCalled()
    },
  )

  it.each([
    { baseline: {}, edit: { valuesRef: 'Sheet1!$A$1:$A$2', values: [3, 4] } },
    { baseline: {}, edit: { categoriesRef: 'Sheet1!$B$1:$B$2', categories: ['c', 'd'] } },
    {
      baseline: { valuesRef: 'Sheet1!$A$1:$A$2' },
      edit: { valuesRef: 'Sheet1!$C$1:$C$2', values: [3, 4] },
    },
    {
      baseline: { categoriesRef: 'Sheet1!$B$1:$B$2' },
      edit: { categoriesRef: 'Sheet1!$D$1:$D$2', categories: ['c', 'd'] },
    },
  ])('reopens when a chart series reference changes: $edit', async ({ baseline, edit }) => {
    const { ctx, journal, state, applySavedWorkbook, openLazyWorkbook } = setup()
    const path = 'xl/charts/chart1.xml'
    state.file.visuals = [
      {
        id: 'chart-1',
        sheetId: 'sheet-1',
        kind: 'chart',
        chartPath: path,
        chart: {
          chartTypes: ['barChart'],
          title: 'original',
          series: [{ name: 'series', values: [1, 2], categories: ['a', 'b'], ...baseline }],
        },
      },
    ] as never
    recordChartEdit(journal, path, { series: [{ index: 0, ...edit }] })
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
    expect(applySavedWorkbook).not.toHaveBeenCalled()
    expect(openLazyWorkbook).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'keeps cache-only series edits in place with referenced baseline=%s',
    async (referenced) => {
      const { ctx, journal, state, applySavedWorkbook, openLazyWorkbook } = setup()
      const path = 'xl/charts/chart1.xml'
      const refs = referenced
        ? { valuesRef: 'Sheet1!$A$1:$A$2', categoriesRef: 'Sheet1!$B$1:$B$2' }
        : {}
      state.file.visuals = [
        {
          id: 'chart-1',
          sheetId: 'sheet-1',
          kind: 'chart',
          chartPath: path,
          chart: {
            chartTypes: ['barChart'],
            title: 'original',
            series: [{ name: 'series', values: [1, 2], categories: ['a', 'b'], ...refs }],
          },
        },
      ] as never
      recordChartEdit(journal, path, {
        series: [{ index: 0, values: [3, 4], categories: ['c', 'd'], ...refs }],
      })
      await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: true })
      expect(applySavedWorkbook).toHaveBeenCalledTimes(1)
      expect(openLazyWorkbook).not.toHaveBeenCalled()
    },
  )

  it('never reopens over a non-cell edit made during a structural save', async () => {
    const { ctx, journal, state, openLazyWorkbook } = setup()
    recordStructuralOp(journal, 'sheet-1', { kind: 'insert-rows', index: 0, count: 1 })
    save.mockImplementationOnce(async () => {
      recordPageSetup(journal, 'sheet-1', { zoomScale: 150 })
      return { canceled: false, file: { ...state.file, sessionId: 'new', sha256: 'new' } }
    })
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: false })
    expect(openLazyWorkbook).not.toHaveBeenCalled()
    expect(ctx.lazyWorkbookRef.current?.editJournal.pageSetup.get('sheet-1')?.zoomScale).toBe(150)
    await expect(handleSave(ctx, 'save')).resolves.toMatchObject({ ok: false })
    await expect(handleSave(ctx, 'recovery')).resolves.toMatchObject({ ok: false })
    expect(save).toHaveBeenCalledTimes(1)
  })
})
