import { describe, expect, it, vi, afterEach } from 'vitest'
import { commitCellEdit, navigateCell } from '../src/renderer/table-actions'
import { nextPlaceholder } from '../src/renderer/placeholder-nav'
vi.mock('../src/renderer/export-render', () => ({ renderSlidesToPngBase64: vi.fn() }))
vi.mock('../src/renderer/components/toast-bus', () => ({ showToast: vi.fn() }))
import { save } from '../src/renderer/file-actions'
import type { ActionCtx } from '../src/renderer/action-context'

const paragraphs = [{ runs: [{ text: 'unsaved draft' }] }]
const updated = { nodes: [] }
function context() {
  return {
    current: 0,
    editing: { sourceId: 'a' },
    editingCell: { sourceId: 'table', row: 0, col: 0 },
    slide: { nodes: [
      { type: 'shape', sourceId: 'a', placeholder: 'title' },
      { type: 'shape', sourceId: 'b', placeholder: 'body' },
      { type: 'table', sourceId: 'table', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
    ] },
    applySlide: vi.fn(), setEditing: vi.fn(), setEditingCell: vi.fn(),
    setSelectedIds: vi.fn(), setStatus: vi.fn(), setSlides: vi.fn(),
    setCurrent: vi.fn(), setSelectedSlides: vi.fn(), setDirty: vi.fn(),
  } as unknown as ActionCtx
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function api(result: unknown) {
  const value = { editTableCell: vi.fn().mockResolvedValue(result), editText: vi.fn().mockResolvedValue(result), tableStructure: vi.fn().mockResolvedValue(null), addBlankSlide: vi.fn().mockResolvedValue(null), deleteElement: vi.fn().mockResolvedValue(result) }
  vi.stubGlobal('slidesApi', value)
  return value
}
describe('failed edit receipts retain draft ownership', () => {
  it('does not close a cell overlay on null; a successful retry closes it', async () => {
    const ctx = context(); const a = api(null)
    await commitCellEdit(ctx, paragraphs)
    expect(ctx.setEditingCell).not.toHaveBeenCalled()
    expect(ctx.applySlide).not.toHaveBeenCalled()
    a.editTableCell.mockResolvedValue(updated)
    await commitCellEdit(ctx, paragraphs)
    expect(ctx.applySlide).toHaveBeenCalledWith(0, updated)
    expect(ctx.setEditingCell).toHaveBeenCalledWith(null)
  })
  it.each([0, 1])('does not navigate or add a row after rejected cell %i', async col => {
    const ctx = context(); ctx.editingCell!.col = col; const a = api(null)
    await navigateCell(ctx, paragraphs, 1)
    expect(ctx.setEditingCell).not.toHaveBeenCalled()
    expect(a.tableStructure).not.toHaveBeenCalled()
  })
  it('does not navigate away from a failed text commit', async () => {
    const ctx = context(); const a = api(null)
    await nextPlaceholder(ctx, paragraphs)
    expect(ctx.setEditing).not.toHaveBeenCalled()
    expect(ctx.setSelectedIds).not.toHaveBeenCalled()
    expect(a.addBlankSlide).not.toHaveBeenCalled()
  })
  it('does not leave an empty text box when deletion failed', async () => {
    const ctx = context(); ctx.editing!.discardIfEmpty = true; api(null)
    await nextPlaceholder(ctx, [])
    expect(ctx.setEditing).not.toHaveBeenCalled()
  })
  it('blocks save of old data after a rejected cell commit', async () => {
    vi.useFakeTimers()
    const ctx = context(); const a = api(null) as any
    a.save = vi.fn().mockResolvedValue({ ok: true, path: '/old.pptx' })
    ctx.editingActiveRef = { current: true }
    ctx.setEditingCell = vi.fn(value => { ctx.editingActiveRef.current = !!value })
    ctx.flushNotes = vi.fn().mockResolvedValue(undefined)
    ctx.setPath = vi.fn(); ctx.path = '/old.pptx'
    await commitCellEdit(ctx, paragraphs)
    const saving = save(() => ctx)
    await vi.advanceTimersByTimeAsync(2100)
    expect(await saving).toBe(false)
    expect(a.save).not.toHaveBeenCalled()
    expect(ctx.setDirty).not.toHaveBeenCalled()
  })
  it('still navigates an unchanged cell without submitting an edit', async () => {
    const ctx = context(); const a = api(null)
    await navigateCell(ctx, null, 1)
    expect(a.editTableCell).not.toHaveBeenCalled()
    expect(ctx.setEditingCell).toHaveBeenCalledWith({ sourceId: 'table', row: 0, col: 1 })
  })
})
