import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePageSlices } from '../../../apps/docs/src/renderer/pagination-slices.ts'

test('blocks that do not fit the page content height continue on the next page', () => {
  const slices = computePageSlices(
    [
      { top: 0, height: 80 },
      { top: 80, height: 80 },
    ],
    100,
    160,
  )
  assert.equal(slices.length, 2)
  assert.equal(slices[0].start, 0)
  assert.ok(slices[0].end <= 100)
  assert.ok(slices[1].start >= slices[0].end)
  assert.equal(slices[1].end, 160)
})
