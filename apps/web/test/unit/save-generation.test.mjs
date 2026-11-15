import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveGenerationGuard } from '../../../../packages/browser-host/src/save-generation.ts'

test('a committed old snapshot cannot mark newer edits saved', () => {
  const guard = createSaveGenerationGuard()
  guard.markEdited()
  const ticket = guard.beginSave()
  guard.markEdited()
  assert.equal(guard.settleSave(ticket, 'committed'), true)
  assert.deepEqual(guard.getState(), { generation: 2, savedGeneration: 1, dirty: true, status: 'idle' })
  const latest = guard.beginSave()
  guard.settleSave(latest, 'committed')
  assert.equal(guard.getState().dirty, false)
})

test('failed saves preserve dirty edits and duplicate completions do nothing', () => {
  const guard = createSaveGenerationGuard()
  guard.markEdited()
  const failed = guard.beginSave()
  guard.settleSave(failed, 'failed')
  assert.equal(guard.getState().dirty, true)
  const current = guard.beginSave()
  assert.equal(guard.settleSave(failed, 'committed'), false)
  assert.equal(guard.getState().status, 'saving')
  guard.settleSave(current, 'committed')
  assert.equal(guard.getState().dirty, false)
})

test('only one snapshot may be in flight and unknown outcome blocks blind retries', () => {
  const guard = createSaveGenerationGuard()
  guard.markEdited()
  const ticket = guard.beginSave()
  assert.throws(() => guard.beginSave(), /pending/)
  guard.settleSave(ticket, 'unknown')
  assert.deepEqual(guard.getState(), { generation: 1, savedGeneration: 0, dirty: true, status: 'unknown' })
  assert.throws(() => guard.beginSave(), /pending/)
  guard.markEdited()
  guard.settleSave(ticket, 'committed') // explicit server reconciliation, not a blind retry
  assert.equal(guard.getState().dirty, true)
  assert.equal(guard.getState().status, 'idle')
})

test('opening another document invalidates old responses even at matching generation', () => {
  const guard = createSaveGenerationGuard()
  guard.markEdited()
  const old = guard.beginSave()
  guard.reset()
  guard.markEdited()
  const current = guard.beginSave()
  assert.equal(old.generation, current.generation)
  assert.equal(guard.settleSave(old, 'committed'), false)
  assert.equal(guard.getState().status, 'saving')
  assert.equal(guard.getState().dirty, true)
  assert.equal(guard.settleSave(current, 'committed'), true)
})

test('tickets cannot be forged, shared across guards or mutated', () => {
  const guard = createSaveGenerationGuard(), other = createSaveGenerationGuard()
  guard.markEdited(); other.markEdited()
  const ticket = guard.beginSave(), foreign = other.beginSave()
  assert.equal(guard.settleSave({ ...ticket }, 'committed'), false)
  assert.equal(guard.settleSave(foreign, 'committed'), false)
  assert.throws(() => { ticket.generation = 0 }, TypeError)
  const snapshot = guard.getState(); snapshot.dirty = false
  assert.equal(guard.getState().dirty, true)
})
test('invalid completions cannot fabricate an idle save or discard a pending snapshot', () => {
  const guard = createSaveGenerationGuard()
  assert.equal(guard.settleSave(null, 'committed'), false)
  guard.markEdited()
  const ticket = guard.beginSave()
  assert.throws(() => guard.settleSave(ticket, 'downloaded'), /Invalid save outcome/)
  assert.equal(guard.getState().status, 'saving')
  assert.equal(guard.getState().dirty, true)
  assert.equal(guard.settleSave(ticket, 'committed'), true)
})
