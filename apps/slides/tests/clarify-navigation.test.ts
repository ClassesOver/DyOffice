import { describe, expect, it } from 'vitest'
import { shouldShowClarifyNext } from '../src/renderer/ai/clarify-navigation'

describe('clarify custom answers', () => {
  it('lets a typed answer advance from a single-select question', () => {
    expect(shouldShowClarifyNext({ isLast: false, multi: false, hasOtherText: true })).toBe(true)
  })

  it('keeps next hidden for an unanswered single-select question', () => {
    expect(shouldShowClarifyNext({ isLast: false, multi: false, hasOtherText: false })).toBe(false)
  })

  it('keeps the final question on its submit action', () => {
    expect(shouldShowClarifyNext({ isLast: true, multi: true, hasOtherText: true })).toBe(false)
  })
})
