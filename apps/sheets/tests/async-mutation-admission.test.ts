import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditJournal, recordPageSetup } from '../src/renderer/edit-journal'
import { mutationAdmission } from '../src/renderer/mutation-admission'
import {
  handleInsertChart,
  handleInsertPictureFile,
  type VisualActionContext,
} from '../src/renderer/visual-actions'
import { insertNotePictureFile } from '../src/renderer/note-picture-actions'
import type { RibbonCommandContext } from '../src/renderer/ribbon-actions'
import { applyChartEdit, applyShapeEdit } from '../src/renderer/visual-edit-sync'
import type { VisualSyncContext } from '../src/renderer/visual-edit-sync'
import { applyChangePlan, type OpExecutorContext } from '../src/renderer/op-executor'

const read = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/univer-sync', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readChartGridValues: read,
  queueVisualInstall: vi.fn(),
  pushVisualUndo: vi.fn(),
}))
let readers: Array<{ result: string; onload: (() => void) | null; onerror: (() => void) | null }> =
  []
function setup() {
  const journal = createEditJournal()
  const state = { editJournal: journal, file: { sessionId: 'one', visuals: [], sheets: [] } }
  const sheet = { getSheetId: () => 'sheet-1', getSheetName: () => 'Data', getNotes: () => [] }
  const workbook = {
    getActiveSheet: () => sheet,
    getSheetBySheetId: () => sheet,
    getActiveRange: () => ({
      getRow: () => 0,
      getColumn: () => 0,
      getWidth: () => 2,
      getHeight: () => 2,
    }),
  }
  const runtime = { univerAPI: { getActiveWorkbook: () => workbook } }
  const ctx = {
    univerRef: { current: runtime },
    lazyWorkbookRef: { current: state },
    setMessage: vi.fn(),
    setPendingEdits: vi.fn(),
    refreshLazyVisuals: vi.fn(),
  } as unknown as VisualActionContext
  return { ctx, state, journal, runtime, gate: mutationAdmission(journal) }
}
beforeEach(() => {
  read.mockReset()
  readers = []
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/png;base64,eA=='
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL() {
        readers.push(this)
      }
    },
  )
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 10
      naturalHeight = 20
      onload: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
})

describe('real async mutation entry admission', () => {
  it('tracks ribbon chart data reading and drains its actual journal commit', async () => {
    const { ctx, gate, journal } = setup()
    let finish!: (value: unknown) => void
    read.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const inserting = handleInsertChart(ctx, 'column')
    expect(gate.activeTasks).toBe(1)
    const lock = gate.close()
    const drain = lock.freeze()
    finish([
      ['Label', 'Value'],
      ['A', 4],
    ])
    await inserting
    await drain
    expect(journal.visualAdds[0]?.chart?.series[0]?.values).toEqual([4])
    expect(gate.phase).toBe('frozen')
    lock.release()
  })

  it('tracks FileReader and Image onload through the picture commit, rejects a new insert visibly', async () => {
    const { ctx, gate, journal } = setup()
    const file = { name: 'picture.png', type: 'image/png', size: 10 } as File
    handleInsertPictureFile(ctx, file)
    const lock = gate.close()
    const drain = lock.freeze()
    handleInsertPictureFile(ctx, file)
    expect(ctx.setMessage).toHaveBeenCalledWith(expect.stringMatching(/saving/i))
    expect(readers).toHaveLength(1)
    readers[0]?.onload?.()
    await drain
    expect(journal.visualAdds).toHaveLength(1)
    expect(journal.visualAdds[0]?.kind).toBe('image')
    lock.release()
  })

  it('drains note picture read and its child apply before freezing rather than deadlocking', async () => {
    const { ctx, gate, journal, runtime } = setup()
    const runOps = vi.fn(async (_ops, _message, lease) =>
      gate.run(async () => ({ ok: true }), lease),
    )
    const inserting = insertNotePictureFile(
      { ...ctx, runOps } as unknown as RibbonCommandContext,
      runtime as never,
      'sheet-1',
      0,
      0,
      { name: 'note.png', type: 'image/png', size: 10 } as File,
    )
    const lock = gate.close()
    const drain = lock.freeze()
    readers[0]?.onload?.()
    await inserting
    await drain
    expect(runOps).toHaveBeenCalledTimes(1)
    expect(journal.notePictures).toHaveLength(1)
    expect(journal.noteDirty.has('sheet-1')).toBe(true)
    lock.release()
  })

  it('rejects queued op apply during a structural save before any prefetch/write', async () => {
    const { ctx, gate, state, runtime } = setup()
    const lock = gate.close()
    const executor = { state, runtime, setMessage: ctx.setMessage } as unknown as OpExecutorContext
    await expect(
      applyChangePlan(
        { structuralChanges: [], cellChanges: [], formatChanges: [] } as never,
        executor,
      ),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/saving/i) })
    expect(read).not.toHaveBeenCalled()
    lock.release()
  })

  it('blocks actual chart/shape callbacks before they can edit arrays or register undo', async () => {
    const { ctx, gate, journal } = setup()
    const lock = gate.close()
    await lock.freeze()
    expect(() =>
      applyChartEdit(ctx as unknown as VisualSyncContext, 'xl/charts/chart1.xml', {
        title: 'late',
      }),
    ).toThrow(/saving/i)
    expect(() =>
      applyShapeEdit(ctx as unknown as VisualSyncContext, 'shape-1', { remove: true }),
    ).toThrow(/saving/i)
    expect(journal.chartEdits.size).toBe(0)
    lock.release()
  })

  it('blocks a direct page/portal-style journal writer after task drain even before freeze', async () => {
    const { gate, journal } = setup()
    const lock = gate.close()
    expect(() => recordPageSetup(journal, 'sheet-1', { zoomScale: 150 })).toThrow(/saving/i)
    lock.release()
  })
})
