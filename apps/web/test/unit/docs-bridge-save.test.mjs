import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocsBridge } from '../../src/editors/docs-bridge.ts'

test('a native save reporting newer metadata retains an unsaved UI state', async () => {
  const host = { getState: () => ({ name: 'a.docx', status: 'idle' }), save: async () => ({}) }
  const bridge = createDocsBridge(host, 'file', { language: 'en' }, () => {})
  await bridge.lifecycle.beforeSave()
  assert.equal((await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))).ok, true)
  // Native serializer detected newer metadata, although no PM update fired.
  bridge.lifecycle.afterSave(false)
  assert.equal(bridge.getState().dirty, true)
})
