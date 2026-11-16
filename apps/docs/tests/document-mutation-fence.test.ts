import { test, expect } from 'vitest'
import { createDocumentMutationFence } from '../src/renderer/document-mutation-fence'
test('metadata invalidates synchronously and one owner cannot acknowledge another', () => {
  const f = createDocumentMutationFence(),
    header = f.registerOwner('header'),
    comments = f.registerOwner('comments'),
    first = header.invalidate(),
    second = comments.invalidate()
  header.acknowledge(second)
  expect(f.snapshot().ready).toBe(false)
  comments.acknowledge(second)
  expect(f.snapshot()).toEqual({ generation: second, ready: true })
})
test('shared clock retains generations across lifecycle and PM work', () => {
  const f = createDocumentMutationFence(),
    lifecycle = f.registerOwner('reload'),
    a = f.recordEditorTransaction(),
    b = lifecycle.invalidate()
  expect(b).toBeGreaterThan(a)
  lifecycle.acknowledge(b)
  expect(f.snapshot()).toEqual({ generation: b, ready: true })
  f.dispose()
  expect(() => f.recordEditorTransaction()).toThrow()
  expect(f.snapshot().ready).toBe(false)
})
test('stale acknowledgement cannot clear newer pending work', () => {
  const f = createDocumentMutationFence(),
    field = f.registerOwner('header'),
    a = field.invalidate(),
    b = field.invalidate()
  f.recordEditorTransaction()
  field.acknowledge(a)
  expect(f.snapshot().ready).toBe(false)
  field.acknowledge(b)
  expect(f.snapshot().ready).toBe(true)
})
