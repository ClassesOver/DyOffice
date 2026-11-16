// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAiDocument } from '../src/renderer/ai/create-document'
import { handleExportCsv } from '../src/renderer/csv-export'
import { createEditJournal } from '../src/renderer/edit-journal'
import { FORMULA_SETTLE_TIMEOUT_MS, settleFormulas } from '../src/renderer/formula-settle'
import { setModuleLang } from '../src/renderer/i18n/locale'
import {
  handleExportPdf,
  openPrintPreviewHost,
  type PageLayoutContext,
} from '../src/renderer/page-layout-actions'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/// A fully loaded one-row workbook (A1 = 2, B1 = 3, C1 = A1*B1) whose formula
/// result has not landed yet, as right after the stream completes on a file
/// saved without cached values.
function harness(pendingFormula = true, appliedBarrier = true) {
  const cells: { v?: number; f?: string }[] = [
    { v: 2 },
    { v: 3 },
    pendingFormula ? { f: '=A1*B1' } : { f: '=A1*B1', v: 6 },
  ]
  const display = () => [cells.map((cell) => (cell.v === undefined ? '' : String(cell.v)))]
  const worksheet = {
    getSheetId: () => 'sheet-1',
    getSheetName: () => 'Sheet1',
    getLastRow: () => 0,
    getLastColumn: () => 2,
    getRowHeight: () => 20,
    getColumnWidth: () => 100,
    getMergedRanges: () => [],
    getRange: () => ({
      getValues: () => [cells.map((cell) => cell.v ?? null)],
      getRawValues: () => [cells.map((cell) => cell.v ?? null)],
      getDisplayValues: display,
      getCellStyleData: () => null,
    }),
    getMaxRows: () => 10,
    getMaxColumns: () => 10,
    isSheetHidden: () => false,
    getSheet: () => ({
      getRowVisible: () => true,
      getColVisible: () => true,
      getCellMatrix: () => ({
        forValue: (visit: (row: number, column: number, cell: { f?: string }) => unknown) =>
          cells.forEach((cell, column) => visit(0, column, cell)),
      }),
    }),
  }
  const calculate = vi.fn()
  let calculationEnd: ((state: number) => void) | null = null
  let resolveApplied: (() => void) | null = null
  const applied = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveApplied = resolve
      }),
  )
  const workbook = {
    getActiveSheet: () => worksheet,
    getActiveRange: () => null,
    getSheets: () => [worksheet],
    getSheetBySheetId: () => worksheet,
    getSnapshot: () => ({
      sheets: { 'sheet-1': { cellData: { 0: Object.fromEntries(cells.entries()) } } },
    }),
  }
  const runtime = {
    univerAPI: {
      getActiveWorkbook: () => workbook,
      getFormula: () => ({
        executeCalculation: calculate,
        ...(appliedBarrier ? { onCalculationResultApplied: applied } : {}),
        calculationEnd: (callback: (state: number) => void) => {
          calculationEnd = callback
          return { dispose: () => undefined }
        },
      }),
    },
  } as unknown as UniverRuntime
  const state = {
    file: {
      name: 'book.xlsx',
      sessionId: 'session-1',
      sheets: [{ id: 'sheet-1', name: 'Sheet1', rowCount: 10, columnCount: 10 }],
      visuals: [],
    },
    flags: { preloadComplete: true, preloadRunning: false },
    editJournal: createEditJournal(),
    sheetFilePageSetups: new Map(),
    sheetPageBreaks: new Map(),
    sheetProtections: new Map(),
    sheetProtectedRanges: new Map(),
    showFormulaSheets: new Set<string>(),
  } as unknown as LazyWorkbookState
  const refs = {
    univerRef: { current: runtime },
    lazyWorkbookRef: { current: state as LazyWorkbookState | null },
    setMessage: () => undefined,
  }
  return {
    csvContext: { ...refs, requestSaveAs: () => undefined },
    pageLayoutContext: {
      ...refs,
      setPendingEdits: vi.fn(),
      requestVisualInstall: vi.fn(),
      runOps: () => Promise.reject(new Error('not used')),
    } as PageLayoutContext,
    calculate,
    applied,
    cells,
    runtime,
    notifyCalculationEnd: () => calculationEnd?.(1),
    applyCalculationResult: (value = 6) => {
      cells[2]!.v = value
      resolveApplied?.()
    },
    /** the engine's pass lands in the model and reports its end */
    finishCalculation: () => {
      cells[2]!.v = 6
      calculationEnd?.(1)
      resolveApplied?.()
    },
  }
}

describe('exports right after the load wait for the formula results', () => {
  let exportCsv: ReturnType<typeof vi.fn>
  let exportPdf: ReturnType<typeof vi.fn>
  let createDocument: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setModuleLang('en')
    exportCsv = vi.fn().mockResolvedValue({ canceled: false, path: 'D:/book.csv' })
    exportPdf = vi.fn().mockResolvedValue({ canceled: false, path: 'D:/book.pdf' })
    createDocument = vi.fn().mockResolvedValue({ ok: true, path: 'D:/book.csv' })
    vi.stubGlobal('window', { desktopApi: { exportCsv, exportPdf, createDocument } })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('CSV export forces a calculation pass and writes the computed value', async () => {
    const h = harness()
    const exported = handleExportCsv(h.csvContext)
    await tick()
    expect(h.calculate).toHaveBeenCalledTimes(1)
    expect(exportCsv).not.toHaveBeenCalled()

    h.finishCalculation()
    await exported
    expect(exportCsv).toHaveBeenCalledTimes(1)
    expect(exportCsv.mock.calls[0]?.[0].content).toBe('2,3,6\r\n')
  })

  it('CSV export recalculates retained caches and waits past calculationEnd for the model apply', async () => {
    const h = harness(false)
    h.cells[0]!.v = 21.25
    // The prior cache is still present: non-null is not proof of freshness.
    const exported = handleExportCsv(h.csvContext)
    await tick()
    expect(h.calculate).toHaveBeenCalledTimes(1)
    expect(h.applied).toHaveBeenCalledTimes(1)
    expect(exportCsv).not.toHaveBeenCalled()
    h.notifyCalculationEnd()
    await tick()
    expect(exportCsv).not.toHaveBeenCalled()
    h.applyCalculationResult(63.75)
    await exported
    expect(exportCsv.mock.calls[0]?.[0].content).toBe('21.25,3,63.75\r\n')
  })

  it('CSV export of a workbook replaced during the pass is dropped', async () => {
    const h = harness()
    const exported = handleExportCsv(h.csvContext)
    await tick()
    h.csvContext.lazyWorkbookRef.current = null
    h.finishCalculation()
    await exported
    expect(exportCsv).not.toHaveBeenCalled()
  })

  it('the AI create_document CSV path waits for the pass', async () => {
    const h = harness()
    const created = createAiDocument(h.csvContext, { type: 'csv', title: 'book' })
    await tick()
    expect(h.calculate).toHaveBeenCalledTimes(1)
    expect(createDocument).not.toHaveBeenCalled()

    h.finishCalculation()
    expect((await created).ok).toBe(true)
    expect(createDocument.mock.calls[0]?.[0].content).toBe('2,3,6\r\n')
  })

  it('the AI create_document path of a workbook replaced during the pass fails', async () => {
    const h = harness()
    const created = createAiDocument(h.csvContext, { type: 'csv', title: 'book' })
    await tick()
    h.csvContext.lazyWorkbookRef.current = null
    h.finishCalculation()
    expect((await created).ok).toBe(false)
    expect(createDocument).not.toHaveBeenCalled()
  })

  it('the ribbon PDF export waits for the pass', async () => {
    const h = harness()
    const exported = handleExportPdf(h.pageLayoutContext)
    await tick()
    expect(h.calculate).toHaveBeenCalledTimes(1)
    expect(exportPdf).not.toHaveBeenCalled()

    h.finishCalculation()
    expect(await exported).toBe(true)
    expect(exportPdf).toHaveBeenCalledTimes(1)
  })

  it('the Print dialog opens once the pass has landed', async () => {
    const h = harness()
    let host: unknown = undefined
    const opened = openPrintPreviewHost(h.pageLayoutContext).then((value) => (host = value))
    await tick()
    expect(h.calculate).toHaveBeenCalledTimes(1)
    expect(host).toBeUndefined()

    h.finishCalculation()
    await opened
    expect(host).not.toBeNull()
  })

  it('legacy fallback settles only formulas missing a cache', async () => {
    const h = harness(true, false)
    const settling = settleFormulas(h.runtime)
    await tick()
    expect(h.calculate).toHaveBeenCalledTimes(1)
    h.finishCalculation()
    await settling
  })

  it('legacy fallback does not wait for every retained formula cache', async () => {
    vi.useFakeTimers()
    const h = harness(false, false)
    const settling = settleFormulas(h.runtime)
    h.finishCalculation()
    await settling
    expect(h.calculate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the model-applied barrier times out instead of allowing a stale snapshot', async () => {
    vi.useFakeTimers()
    const h = harness(false)
    const settling = settleFormulas(h.runtime)
    const rejected = expect(settling).rejects.toThrow('Formula results were not applied')
    await vi.advanceTimersByTimeAsync(FORMULA_SETTLE_TIMEOUT_MS)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an engine that never settles still exports after the bound', async () => {
    vi.useFakeTimers()
    const h = harness(true, false)
    const exported = handleExportCsv(h.csvContext)
    await vi.advanceTimersByTimeAsync(2 * FORMULA_SETTLE_TIMEOUT_MS + 1000)
    await exported
    expect(exportCsv.mock.calls[0]?.[0].content).toBe('2,3,\r\n')
  })
})
