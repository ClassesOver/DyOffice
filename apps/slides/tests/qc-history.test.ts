import { describe, expect, it, vi } from 'vitest'
import { runQcHistoryBatch } from '../src/renderer/ai/qc-history'

describe('QC history lifecycle', () => {
  it('skips mutation when a rollback batch cannot be opened', async () => {
    const run = vi.fn(), end = vi.fn()
    expect(await runQcHistoryBatch({ begin: async () => false, end }, run)).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it('closes a batch after a thrown or cancelled pass', async () => {
    for (const failure of [new Error('provider failed'), new DOMException('Cancelled', 'AbortError')]) {
      const end = vi.fn(async () => 12)
      await expect(runQcHistoryBatch({ begin: async () => true, end }, async () => { throw failure })).rejects.toBe(failure)
      expect(end).toHaveBeenCalledTimes(1)
    }
  })

  it('attempts to close a batch when the begin response is lost', async () => {
    const run = vi.fn(), end = vi.fn(async () => null)
    await expect(runQcHistoryBatch({ begin: async () => { throw new Error('lost begin response') }, end }, run)).rejects.toThrow('lost begin response')
    expect(run).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('returns the confirmed checkpoint and propagates an unconfirmed close', async () => {
    expect(await runQcHistoryBatch({ begin: async () => true, end: async () => 12 }, async () => 'done')).toEqual({ result: 'done', snapshotId: 12 })
    await expect(runQcHistoryBatch({ begin: async () => true, end: async () => { throw new Error('network') } }, async () => 'done')).rejects.toThrow('network')
  })
})
