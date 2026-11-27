// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPageSetupState } from '@genoffice/xlsx-gateway/gateway/xlsx-page-setup'
import {
  handleExportPdf,
  openHeaderFooterEditor,
  openPrintPreviewHost,
  type PageLayoutContext,
} from '../src/renderer/page-layout-actions'
import { createEditJournal, recordHyperlinkEdit, toSavePageSetupStates } from '../src/renderer/edit-journal'
import { startFullLoad } from '../src/renderer/full-load'
import { workbookCellCounts } from '../src/renderer/load-budget'
import { setModuleLang } from '../src/renderer/i18n/locale'
import { assemblePrintHtml } from '../src/renderer/print-html'
import { resolveEffectivePageSetup } from '../src/renderer/print-settings'
import { fullLoadGate } from '../src/renderer/reorder-gate'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'
import { preloadEntireWorkbook } from '../src/renderer/univer-sync'

vi.mock('../src/renderer/univer-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/univer-sync')>()
  return {
    ...actual,
    preloadEntireWorkbook: vi.fn(),
  }
})

type FileSheet = LazyWorkbookState['file']['sheets'][number]

/// A complete WorkbookRangeResult for a sheet whose file state was never
/// captured: the print paths answer ensureSheetFileState's read with it.
function fileStateResult(pageSetup: unknown = null, indexingComplete = true) {
  return {
    cells: [],
    rows: [],
    indexingComplete,
    indexedThroughRow: 1,
    sheetProtection: null,
    rowBreaks: [],
    colBreaks: [],
    pageSetup,
    protectedRanges: [],
  }
}

/// Behaves like the real preloadEntireWorkbook as far as the callers can see:
/// flags the workbook running, finishes after `ms`, then flags it complete.
function fakePreload(ms: number) {
  vi.mocked(preloadEntireWorkbook).mockImplementation(async (_runtime, ref) => {
    const state = ref.current
    if (!state) return
    state.flags.preloadRunning = true
    await new Promise((resolve) => setTimeout(resolve, ms))
    state.flags.preloadRunning = false
    state.flags.preloadComplete = true
  })
}

describe('print and PDF workbook readiness coordination', () => {
  let messages: string[] = []
  let printWorkbookMock: ReturnType<typeof vi.fn>
  let exportPdfMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(preloadEntireWorkbook).mockReset()
    setModuleLang('en')
    messages = []
    printWorkbookMock = vi.fn().mockResolvedValue({ ok: true })
    exportPdfMock = vi.fn().mockResolvedValue({ canceled: false, path: 'D:/test.pdf' })

    vi.stubGlobal('window', {
      desktopApi: {
        printWorkbook: printWorkbookMock,
        exportPdf: exportPdfMock,
        readWorkbookRange: vi.fn().mockResolvedValue(fileStateResult()),
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function sheet(overrides: Partial<FileSheet> = {}): FileSheet {
    return {
      id: 'sheet-1',
      name: 'Sheet1',
      rowCount: 10,
      columnCount: 10,
      ...overrides,
    } as FileSheet
  }

  function createMockState(
    sheets: readonly FileSheet[] = [sheet()],
    preloadRunning = false,
  ): LazyWorkbookState {
    return {
      file: { name: 'test.xlsx', sessionId: 'session-123', sheets, visuals: [] },
      flags: { preloadComplete: false, preloadRunning },
      editJournal: createEditJournal(),
      hyperlinkTargets: new Map(),
      sheetFilePageSetups: new Map(),
      sheetPageBreaks: new Map(),
      sheetProtections: new Map(),
      sheetProtectedRanges: new Map(),
    } as unknown as LazyWorkbookState
  }

  function createMockContext(state: LazyWorkbookState | null): PageLayoutContext {
    const grid = [['A1', 'B1'], ['A2', 'B2']]
    const valuesAt = (row: number, column: number, rowCount: number, columnCount: number) =>
      grid.slice(row, row + rowCount).map((cells) => cells.slice(column, column + columnCount))
    const worksheet = {
      getSheetId: () => 'sheet-1',
      getSheetName: () => 'Sheet1',
      getLastRow: () => 1,
      getLastColumn: () => 1,
      getRowHeight: () => 20,
      getColumnWidth: () => 100,
      getMergedRanges: () => [],
      getRange: (row: number, column: number, rowCount = 1, columnCount = 1) => ({
        getValues: () => valuesAt(row, column, rowCount, columnCount),
        getDisplayValues: () => valuesAt(row, column, rowCount, columnCount),
        getCellStyleData: () => null,
      }),
      getMaxRows: () => 10,
      getMaxColumns: () => 10,
      isSheetHidden: () => false,
    }
    const workbook = {
      getActiveSheet: () => worksheet,
      getActiveRange: () => null,
      getSheets: () => [worksheet],
      getSheetBySheetId: () => worksheet,
      getSnapshot: () => ({ sheets: {} }),
    }
    const runtime = {
      univerAPI: { getActiveWorkbook: () => workbook },
    } as unknown as UniverRuntime

    return {
      univerRef: { current: runtime },
      lazyWorkbookRef: { current: state },
      setMessage: (message) => {
        messages.push(message)
      },
      setPendingEdits: vi.fn(),
      requestVisualInstall: vi.fn(),
      runOps: () => Promise.reject(new Error('page layout ops are not used here')),
    }
  }

  it('loads the saved header and footer and preserves formatting in untouched sections', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    const oddHeader = '&LOld&C&BReport&B'
    const oddFooter = '&R&"Calibri,Bold"&12Page &P'
    const readWorkbookRange = vi.fn().mockResolvedValue(fileStateResult({ oddHeader, oddFooter }))
    vi.stubGlobal('window', { desktopApi: { readWorkbookRange } })
    const editor = await openHeaderFooterEditor(ctx)
    expect(readWorkbookRange).toHaveBeenCalledOnce()
    expect(editor).toMatchObject({
      header: { left: 'Old', center: '&BReport&B' },
      footer: { right: '&"Calibri,Bold"&12Page &P' },
    })
    if (editor === null) throw new Error('Header and footer editor did not open')
    expect(editor.apply({ header: editor.header, footer: editor.footer })).toBeNull()
    expect(toSavePageSetupStates(state.editJournal)).toEqual([])
    expect(editor.apply({
      header: { ...editor.header, left: 'Updated' },
      footer: editor.footer,
    })).toBeNull()

    const changes = toSavePageSetupStates(state.editJournal)
    expect(changes).toEqual([
      { sheetId: 'sheet-1', header: { left: 'Updated', center: '&BReport&B' } },
    ])
    const originalFooter = '<oddFooter>&amp;R&amp;"Calibri,Bold"&amp;12Page &amp;P</oddFooter>'
    const output = applyPageSetupState(
      `<worksheet><sheetData/><headerFooter><oddHeader>&amp;LOld&amp;C&amp;BReport&amp;B</oddHeader>${originalFooter}</headerFooter></worksheet>`,
      { sheetName: 'Sheet1', ...changes[0] },
    )
    expect(output).toContain('<oddHeader>&amp;LUpdated&amp;C&amp;BReport&amp;B</oddHeader>')
    expect(output).toContain(originalFooter)
    expect(resolveEffectivePageSetup(changes[0] ?? {}, { oddHeader, oddFooter }, null).header)
      .toEqual({ left: 'Updated', center: '&BReport&B' })

    const reopened = await openHeaderFooterEditor(ctx)
    if (reopened === null) throw new Error('Header and footer editor did not reopen')
    expect(reopened.header).toEqual({ left: 'Updated', center: '&BReport&B' })
    expect(reopened.apply({ header: reopened.header, footer: null })).toBeNull()
    expect(toSavePageSetupStates(state.editJournal)[0]?.footer).toBeNull()
  })

  it('prints saved header and footer references with the current workbook theme', async () => {
    const state = createMockState()
    state.flags.preloadComplete = true
    state.file.themeColors = ['#FFFFFF', '#000000', '#EEEEEE', '#333333', '#234567']
    state.file.themeFonts = { major: 'Georgia', minor: 'Verdana' }
    state.sheetProtections.set('sheet-1', null)
    state.sheetFilePageSetups.set('sheet-1', {
      oddHeader: '&C&"+"&K04+000Report',
      oddFooter: '&R&"-"Page &P',
    })
    const host = await openPrintPreviewHost(createMockContext(state))
    if (host === null) throw new Error('Print preview failed to open')
    const job = await host.buildJob('active', {})
    const html = assemblePrintHtml(job.documents).html
    expect(html).toContain('<span style="font-family:&quot;Georgia&quot;;color:#234567">Report</span>')
    expect(html).toContain('<span style="font-family:&quot;Verdana&quot;">Page 1</span>')
  })

  it('prints saved cell links with pending edits applied', async () => {
    const state = createMockState()
    state.flags.preloadComplete = true
    state.sheetProtections.set('sheet-1', null)
    state.hyperlinkTargets.set('sheet-1', new Map([
      ['0:0', 'https://example.test/replaced'],
      ['0:1', 'https://example.test/removed'],
      ['1:0', 'https://example.test/saved'],
    ]))
    recordHyperlinkEdit(state.editJournal, 'sheet-1', 0, 0, 'https://example.test/current')
    recordHyperlinkEdit(state.editJournal, 'sheet-1', 0, 1, null)
    recordHyperlinkEdit(state.editJournal, 'sheet-1', 1, 1, 'https://example.test/new')
    const host = await openPrintPreviewHost(createMockContext(state))
    if (host === null) throw new Error('Print preview failed to open')
    const job = await host.buildJob('active', {})
    const html = assemblePrintHtml(job.documents).html

    expect(html).toMatch(/href="https:\/\/example\.test\/current"[^>]*>A1<\/a>/)
    expect(html).toMatch(/href="https:\/\/example\.test\/saved"[^>]*>A2<\/a>/)
    expect(html).toMatch(/href="https:\/\/example\.test\/new"[^>]*>B2<\/a>/)
    expect(html).toContain('>B1</span>')
    expect(html).not.toContain('https://example.test/replaced')
    expect(html).not.toContain('https://example.test/removed')
  })

  it('PDF export of a streamed workbook preloads it first and exports', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    fakePreload(10)

    expect(await handleExportPdf(ctx)).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
    expect(messages).toContain(
      'PDF export needs the fully loaded workbook — wait for loading to finish.',
    )
    expect(messages).toContain('Exported D:/test.pdf.')
  })

  it('opens the Web print dialog for PDF output without reporting a saved file', async () => {
    const state = createMockState()
    state.flags.preloadComplete = true
    state.sheetProtections.set('sheet-1', null)
    const printWorkbook = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('window', { desktopApi: { browserPrintDialog: true, printWorkbook, exportPdf: exportPdfMock } })

    expect(await handleExportPdf(createMockContext(state))).toBe(false)
    expect(printWorkbook).toHaveBeenCalledOnce()
    expect(printWorkbook.mock.calls[0]?.[0].html).toContain('class="page ')
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages).toContain('System print dialog…')
  })

  it('Print of a streamed workbook preloads it first and opens the dialog host', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    fakePreload(10)

    const host = await openPrintPreviewHost(ctx)
    expect(host).not.toBeNull()
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(state.flags.preloadComplete).toBe(true)
  })

  it('opens the Print dialog at once for a fully loaded workbook', async () => {
    const state = createMockState()
    state.flags.preloadComplete = true

    expect(await openPrintPreviewHost(createMockContext(state))).not.toBeNull()
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
  })

  it('joins a load the user already started instead of starting a second one', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    fakePreload(20)
    const userLoad = startFullLoad(ctx.univerRef.current!, ctx.lazyWorkbookRef, () => undefined)

    expect(await handleExportPdf(ctx)).toBe(true)
    await userLoad
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
  })

  it('a Load-all click during a print-triggered preload joins it', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    fakePreload(20)

    const pdf = handleExportPdf(ctx)
    expect(state.flags.preloadRunning).toBe(true)
    const userLoad = startFullLoad(ctx.univerRef.current!, ctx.lazyWorkbookRef, () => undefined)

    expect(await pdf).toBe(true)
    await userLoad
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
  })

  it('a filter click during a print-triggered preload gets the in-progress notice', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    const cellCounts = workbookCellCounts(state.file.sheets)
    const gate = () =>
      fullLoadGate({ formulaMode: false, preloadRunning: state.flags.preloadRunning, cellCounts })
    fakePreload(20)

    expect(gate()).toBe('offerFullLoad')
    const pdf = handleExportPdf(ctx)
    expect(gate()).toBe('loading')
    await pdf
    expect(state.flags.preloadComplete).toBe(true)
  })

  it('a failed preload cancels the export and the Print dialog with the failure message', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    vi.mocked(preloadEntireWorkbook).mockRejectedValue(new Error('Preload disk error'))

    expect(await handleExportPdf(ctx)).toBe(false)
    expect(await openPrintPreviewHost(ctx)).toBeNull()
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages).toContain('Unable to export the PDF.')
    expect(messages).toContain('Unable to print.')
  })

  it('a preload that ends without completing cancels the export', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    vi.mocked(preloadEntireWorkbook).mockResolvedValue(undefined)

    expect(await handleExportPdf(ctx)).toBe(false)
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages.at(-1)).toBe('Unable to export the PDF.')
  })

  it('a preload that never finishes gives up after the timeout', async () => {
    vi.useFakeTimers()
    const state = createMockState()
    const ctx = createMockContext(state)
    vi.mocked(preloadEntireWorkbook).mockReturnValue(new Promise(() => undefined))

    const pdf = handleExportPdf(ctx)
    await vi.advanceTimersByTimeAsync(180_000)

    expect(await pdf).toBe(false)
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages.at(-1)).toBe('Unable to export the PDF.')
  })

  it('a workbook over the full-load budget is refused without preloading, with a wording that fits', async () => {
    const state = createMockState([sheet({ rowCount: 10_000, columnCount: 200 })])
    const ctx = createMockContext(state)

    expect(await handleExportPdf(ctx)).toBe(false)
    expect(await openPrintPreviewHost(ctx)).toBeNull()
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages).toEqual([
      'This workbook is too large to load fully into memory, so it cannot be printed or exported to PDF.',
      'This workbook is too large to load fully into memory, so it cannot be printed or exported to PDF.',
    ])
  })

  it('a sparse workbook inside the shared budget is loaded, not refused', async () => {
    // 5M-cell bounding box but only 100k stored cells: the Load-all prompt
    // offers this, so Print and PDF export must too.
    const state = createMockState([
      sheet({ rowCount: 50_000, columnCount: 100, storedCellCount: 100_000 }),
    ])
    const ctx = createMockContext(state)
    fakePreload(5)

    expect(await handleExportPdf(ctx)).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
  })

  it('switching workbooks while preloading aborts the export quietly', async () => {
    const stateA = createMockState()
    const stateB = createMockState([])
    const ctx = createMockContext(stateA)
    vi.mocked(preloadEntireWorkbook).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      ctx.lazyWorkbookRef.current = stateB
      stateA.flags.preloadComplete = true
    })
    messages.length = 0

    expect(await handleExportPdf(ctx)).toBe(false)
    expect(exportPdfMock).not.toHaveBeenCalled()
    expect(messages).not.toContain('Unable to export the PDF.')
  })

  it('an untitled workbook (no lazy state) prints and exports without a preload', async () => {
    const ctx = createMockContext(null)

    expect(await openPrintPreviewHost(ctx)).not.toBeNull()
    expect(await handleExportPdf(ctx)).toBe(true)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
    expect(preloadEntireWorkbook).not.toHaveBeenCalled()
  })

  it('concurrent Print and PDF export share one preload', async () => {
    const state = createMockState()
    const ctx = createMockContext(state)
    fakePreload(30)

    const [host, pdfOk] = await Promise.all([openPrintPreviewHost(ctx), handleExportPdf(ctx)])
    expect(host).not.toBeNull()
    expect(pdfOk).toBe(true)
    expect(preloadEntireWorkbook).toHaveBeenCalledTimes(1)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
  })
})

describe('headless export (outPath): every sheet, formulas settled', () => {
  let messages: string[] = []
  let exportPdfMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(preloadEntireWorkbook).mockReset()
    setModuleLang('en')
    messages = []
    exportPdfMock = vi.fn().mockResolvedValue({ canceled: false, path: 'D:/book.pdf' })
    vi.stubGlobal('window', {
      desktopApi: {
        printWorkbook: vi.fn().mockResolvedValue({ ok: true }),
        exportPdf: exportPdfMock,
        readWorkbookRange: vi.fn().mockResolvedValue(fileStateResult()),
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** a worksheet mock whose identity answers through `id`; layout reads the same values as the old mock */
  function mockSheet(id: string, name: string, hidden = false) {
    return {
      getSheetId: () => id,
      getSheetName: () => name,
      getLastRow: () => 1,
      getLastColumn: () => 1,
      getRowHeight: () => 20,
      getColumnWidth: () => 100,
      getMergedRanges: () => [],
      getRange: () => ({
        getValues: () => [['A1']],
        getDisplayValues: () => [['A1']],
        getCellStyleData: () => null,
      }),
      getMaxRows: () => 10,
      getMaxColumns: () => 10,
      isSheetHidden: () => hidden,
      activate: vi.fn(),
    }
  }

  function headlessContext(sheetCells: Record<string, unknown> = {}) {
    const sheet1 = mockSheet('sheet-1', 'Data')
    const sheet2 = mockSheet('sheet-2', 'Charts')
    const hidden = mockSheet('sheet-3', 'Hidden', true)
    let snapshot: unknown = {
      sheets: {
        'sheet-1': { name: 'Data', cellData: { 0: { 0: sheetCells } } },
        'sheet-2': { name: 'Charts', cellData: {} },
      },
    }
    const calculate = vi.fn()
    let calculationEnd: ((state: number) => void) | null = null
    const workbook = {
      getActiveSheet: () => sheet1,
      getActiveRange: () => null,
      getSheets: () => [sheet1, sheet2, hidden],
      getSheetBySheetId: (id: string) =>
        id === 'sheet-1' ? sheet1 : id === 'sheet-2' ? sheet2 : hidden,
      getSnapshot: () => snapshot,
    }
    const runtime = {
      univerAPI: {
        getActiveWorkbook: () => workbook,
        getFormula: () => ({
          executeCalculation: calculate,
          calculationEnd: (cb: (state: number) => void) => {
            calculationEnd = cb
            return { dispose: () => undefined }
          },
        }),
      },
    } as unknown as UniverRuntime
    const state = {
      file: {
        name: 'book.xlsx',
        sessionId: 'session-123',
        sheets: [
          { id: 'sheet-1', name: 'Data', rowCount: 10, columnCount: 10 },
          { id: 'sheet-2', name: 'Charts', rowCount: 10, columnCount: 10 },
          { id: 'sheet-3', name: 'Hidden', rowCount: 10, columnCount: 10 },
        ],
        visuals: [],
      },
      flags: { preloadComplete: true, preloadRunning: false },
      editJournal: createEditJournal(),
      hyperlinkTargets: new Map(),
      sheetFilePageSetups: new Map(),
      sheetPageBreaks: new Map(),
      sheetProtections: new Map(),
      sheetProtectedRanges: new Map(),
    } as unknown as LazyWorkbookState
    return {
      ctx: {
        univerRef: { current: runtime },
        lazyWorkbookRef: { current: state },
        setMessage: (message: string) => messages.push(message),
        setPendingEdits: vi.fn(),
        requestVisualInstall: vi.fn(),
        runOps: () => Promise.reject(new Error('not used')),
      } as PageLayoutContext,
      sheet1,
      sheet2,
      calculate,
      formulasComputed: () => {
        snapshot = {
          sheets: {
            'sheet-1': { name: 'Data', cellData: { 0: { 0: { ...sheetCells, v: 42 } } } },
            'sheet-2': { name: 'Charts', cellData: {} },
          },
        }
      },
      fireCalculationEnd: () => calculationEnd?.(1),
    }
  }

  it('prints inactive sheet drawings with live edits and media without activating the sheet', async () => {
    const h = headlessContext()
    const state = h.ctx.lazyWorkbookRef.current!
    const anchor = {
      fromRow: 0, fromColumn: 0, toRow: 2, toColumn: 2,
      fromRowOffset: 0, fromColumnOffset: 0, toRowOffset: 0, toColumnOffset: 0,
    }
    state.file.visuals = [
      {
        id: 'inactive-chart', sheetId: 'sheet-2', kind: 'chart', anchor,
        chartPath: 'xl/charts/chart1.xml',
        chart: { chartTypes: ['barChart'], title: 'Original chart',
          series: [{ name: 'Revenue', categories: ['Jan'], values: [42] }] },
      },
      {
        id: 'inactive-image', sheetId: 'sheet-2', kind: 'image', anchor,
        altText: 'Printed logo',
      },
    ]
    state.editJournal.chartEdits.set('xl/charts/chart1.xml', { title: 'Edited chart' })
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT4sAAAAASUVORK5CYII='
    const readWorkbookMedia = vi.fn().mockResolvedValue({ mediaType: 'image/png', base64 })
    Object.assign(window.desktopApi, { readWorkbookMedia })
    const host = await openPrintPreviewHost(h.ctx)
    if (!host) throw new Error('Print preview failed to open')
    const job = await host.buildJob('workbook', {})
    const html = assemblePrintHtml(job.documents).html
    expect(html).toContain('Edited chart')
    expect(html).toContain(`data:image/png;base64,${base64}`)
    expect(readWorkbookMedia).toHaveBeenCalledWith({
      sessionId: 'session-123', visualId: 'inactive-image',
    })
    expect(document.querySelector('[data-print-stage]')).toBeNull()
    expect(await handleExportPdf(h.ctx, 'D:/book.pdf')).toBe(true)
    const request = exportPdfMock.mock.calls[0]?.[0]
    expect(request.html).toContain('Edited chart')
    expect(request.html).toContain(`data:image/png;base64,${base64}`)
    expect(h.sheet1.activate).not.toHaveBeenCalled()
    expect(h.sheet2.activate).not.toHaveBeenCalled()
  })

  it('opens a chart sheet with its saved setup and prints one chart-only page', async () => {
    const h = headlessContext()
    const state = h.ctx.lazyWorkbookRef.current!
    state.file.sheets[0]!.chartSheet = true
    state.file.visuals = [{
      id: 'standalone-chart',
      sheetId: 'sheet-1',
      kind: 'chart',
      anchor: {
        fromRow: 0, fromColumn: 0, toRow: 0, toColumn: 0,
        fromRowOffset: 0, fromColumnOffset: 0,
        toRowOffset: 600 * 9525, toColumnOffset: 1_200 * 9525,
      },
      chart: { chartTypes: ['barChart'], title: 'Standalone revenue',
        series: [{ name: 'Sales', values: [42], categories: ['Jan'] }] },
    }]
    const readWorkbookRange = vi.fn().mockResolvedValue(fileStateResult({
      orientation: 'landscape',
      paperSize: 9,
      firstPageNumber: 8,
      oddFooter: '&RChart &P',
    }))
    Object.assign(window.desktopApi, { readWorkbookRange })

    const host = await openPrintPreviewHost(h.ctx)
    if (!host) throw new Error('Print preview failed to open')
    expect(host.chartSheet).toBe(true)
    expect(host.setup.orientation).toBe('landscape')
    expect(host.hasSelection).toBe(false)
    const job = await host.buildJob('active', {})
    expect(job.pageCount).toBe(1)
    const html = assemblePrintHtml(job.documents).html
    expect(html).toContain('Standalone revenue')
    expect(html).toContain('Chart 8')
    expect(html).not.toContain('<table ')
    expect(h.sheet1.activate).not.toHaveBeenCalled()
  })

  it('prints every visible sheet without changing its active tab', async () => {
    const h = headlessContext()
    expect(await handleExportPdf(h.ctx, 'D:/book.pdf')).toBe(true)
    const request = exportPdfMock.mock.calls[0]?.[0]
    expect(request.fileName).toBe('book.pdf')
    // one page block per sheet: the hidden third sheet is not in the file
    const pages = request.html.match(/<div class="page /g) ?? []
    expect(pages).toHaveLength(2)
    expect(h.sheet2.activate).not.toHaveBeenCalled()
    expect(h.sheet1.activate).not.toHaveBeenCalled()
    expect(messages).toContain('Exported D:/book.pdf.')
  })

  it('the ribbon export still prints the active sheet only', async () => {
    const h = headlessContext()
    expect(await handleExportPdf(h.ctx)).toBe(true)
    const request = exportPdfMock.mock.calls[0]?.[0]
    expect(request.html.match(/<div class="page /g) ?? []).toHaveLength(1)
    expect(h.calculate).not.toHaveBeenCalled()
  })

  it('forces a calculation pass and waits for the values before printing', async () => {
    const h = headlessContext({ f: '=B2*C2' })
    const pdf = handleExportPdf(h.ctx, 'D:/book.pdf')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.calculate).toHaveBeenCalled()
    // the engine finishes: values land, calculationEnd fires
    h.formulasComputed()
    h.fireCalculationEnd()
    expect(await pdf).toBe(true)
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
  })

  it('a formula engine that never settles still exports after the bound', async () => {
    vi.useFakeTimers()
    const h = headlessContext({ f: '=B2*C2' })
    const pdf = handleExportPdf(h.ctx, 'D:/book.pdf')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await pdf).toBe(true)
    expect(h.calculate).toHaveBeenCalled()
    expect(exportPdfMock).toHaveBeenCalledTimes(1)
  })

  it('an unvisited sheet prints with its file page setup, not the defaults', async () => {
    const h = headlessContext()
    const readWorkbookRange = vi
      .fn()
      .mockImplementation(async (request: { sheetId: string }) =>
        request.sheetId === 'sheet-2'
          ? fileStateResult({ orientation: 'landscape' })
          : fileStateResult(),
      )
    ;(window.desktopApi as unknown as Record<string, unknown>).readWorkbookRange = readWorkbookRange

    expect(await handleExportPdf(h.ctx, 'D:/book.pdf')).toBe(true)
    const html = (exportPdfMock.mock.calls[0]?.[0] as { html: string }).html
    // One page block per sheet, in sheet order; the second (never visited)
    // sheet's landscape A4 swaps the page's inline width and height.
    const pages = html.match(/<div class="page p\d+" style="width:[\d.]+in;height:[\d.]+in"/g) ?? []
    expect(pages).toHaveLength(2)
    expect(pages[1]).toContain('width:11.69in;height:8.27in')
  })

  it('a sheet with captured file state prints without re-reading the file', async () => {
    const h = headlessContext()
    const state = h.ctx.lazyWorkbookRef.current!
    for (const id of ['sheet-1', 'sheet-2']) {
      state.sheetProtections.set(id, {
        protected: false,
        hasPassword: false,
        allow: {} as never,
        password: null,
      })
    }
    const readWorkbookRange = vi.fn()
    ;(window.desktopApi as unknown as Record<string, unknown>).readWorkbookRange = readWorkbookRange

    expect(await handleExportPdf(h.ctx, 'D:/book.pdf')).toBe(true)
    expect(readWorkbookRange).not.toHaveBeenCalled()
  })

  it('an unvisited sheet whose indexing never completes still prints with the defaults', async () => {
    vi.useFakeTimers()
    const h = headlessContext()
    const readWorkbookRange = vi.fn().mockResolvedValue(fileStateResult(null, false))
    ;(window.desktopApi as unknown as Record<string, unknown>).readWorkbookRange = readWorkbookRange

    const pdf = handleExportPdf(h.ctx, 'D:/book.pdf')
    // Both sheets poll for the full ensureSheetFileState bound.
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await pdf).toBe(true)
    const html = (exportPdfMock.mock.calls[0]?.[0] as { html: string }).html
    const pages = html.match(/<div class="page p\d+" style="width:[\d.]+in;height:[\d.]+in"/g) ?? []
    expect(pages).toHaveLength(2)
    expect(pages[1]).toContain('width:8.27in;height:11.69in')
  })
})
