import { describe, expect, it, vi } from 'vitest'
import { completeAiRunSave } from '../src/renderer/ai/ai-run-save'

describe('completeAiRunSave', () => {
  it('saves a successful merge mutation at the end of an autosaved AI run', async () => {
    let journal = 1
    const save = vi.fn(async () => {
      journal = 0
    })

    await completeAiRunSave({
      applies: [],
      mutated: true,
      hasPendingEdits: () => journal > 0,
      autoSave: true,
      save,
      onUnsaved: vi.fn(),
    })

    expect(save).toHaveBeenCalledOnce()
    expect(journal).toBe(0)
  })

  it('keeps a successful merge mutation in the journal when autosave is off', async () => {
    let journal = 1
    const save = vi.fn(async () => {
      journal = 0
    })
    const onUnsaved = vi.fn()

    await completeAiRunSave({
      applies: [],
      mutated: true,
      hasPendingEdits: () => journal > 0,
      autoSave: false,
      save,
      onUnsaved,
    })

    expect(save).not.toHaveBeenCalled()
    expect(journal).toBe(1)
    expect(onUnsaved).toHaveBeenCalledOnce()
  })
})
