import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionCtx } from '../src/renderer/action-context'
import { saveRehearseTimings } from '../src/renderer/show-actions'

afterEach(() => {
  vi.unstubAllGlobals()
})

function context(setPendingRehearse: ReturnType<typeof vi.fn>, setDirty = vi.fn(), setStatus = vi.fn()) {
  return {
    pendingRehearse: [2, 0, 4],
    setPendingRehearse,
    setDirty,
    setStatus,
  } as unknown as ActionCtx
}

describe('saveRehearseTimings', () => {
  it('keeps failed timings and reports failure so the user can retry', async () => {
    const setPendingRehearse = vi.fn()
    const setDirty = vi.fn()
    const setStatus = vi.fn()
    const setAdvanceTimes = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', { slidesApi: { setAdvanceTimes } })
    const ctx = context(setPendingRehearse, setDirty, setStatus)

    await saveRehearseTimings(ctx)

    expect(setAdvanceTimes).toHaveBeenCalledWith({
      times: [
        { slideIndex: 0, ms: 2000 },
        { slideIndex: 2, ms: 4000 },
      ],
    })
    expect(setPendingRehearse).not.toHaveBeenCalled()
    expect(setDirty).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith(expect.stringMatching(/save failed|保存失败/i))
  })

  it('keeps timings after an exception and clears them only after a successful retry', async () => {
    const setPendingRehearse = vi.fn()
    const setDirty = vi.fn()
    const setStatus = vi.fn()
    const setAdvanceTimes = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(true)
    vi.stubGlobal('window', { slidesApi: { setAdvanceTimes } })
    const ctx = context(setPendingRehearse, setDirty, setStatus)

    await saveRehearseTimings(ctx)
    expect(setPendingRehearse).not.toHaveBeenCalled()
    expect(setDirty).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith(expect.stringMatching(/save failed|保存失败/i))

    await saveRehearseTimings(ctx)
    expect(setAdvanceTimes).toHaveBeenCalledTimes(2)
    expect(setPendingRehearse).toHaveBeenCalledWith(null)
    expect(setDirty).toHaveBeenCalledWith(true)
  })
})
