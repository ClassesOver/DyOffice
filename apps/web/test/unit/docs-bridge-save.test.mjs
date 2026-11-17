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
  assert.equal(bridge.getState().nativeSaveOutcome, 'incomplete')
  assert.equal(bridge.getState().dirty, true)
})

 test('a fully accepted native save clears dirty only after the native acknowledgement', async () => {
  const host = { getState: () => ({ name: 'a.docx', status: 'idle' }), save: async () => ({}) }
  const bridge = createDocsBridge(host, 'file', { language: 'en' }, () => {})
  bridge.lifecycle.edited()
  await bridge.lifecycle.beforeSave()
  bridge.lifecycle.edited()
  assert.equal((await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))).ok, true)
  assert.equal(bridge.getState().dirty, true)
  bridge.lifecycle.afterSave(false)
  assert.equal(bridge.getState().nativeSaveOutcome, 'incomplete')
  assert.equal(bridge.getState().dirty, true)
  await bridge.lifecycle.beforeSave()
  await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))
  bridge.lifecycle.afterSave(true)
  assert.equal(bridge.getState().nativeSaveOutcome, 'accepted')
  assert.equal(bridge.getState().dirty, false)
})

test('lost HTTP save cannot become clean through a native acknowledgement', async () => {
  let status='idle'
  const host = { getState: () => ({ name: 'a.docx', status }), save: async () => { status='unknown'; throw Error('response lost') } }
  const bridge = createDocsBridge(host, 'file', { language: 'en' }, () => {})
  bridge.lifecycle.edited()
  await bridge.lifecycle.beforeSave()
  assert.equal((await bridge.api.saveDocx('/files/file/a.docx', new ArrayBuffer(1))).ok, false)
  bridge.lifecycle.afterSave(true)
  assert.equal(bridge.getState().nativeSaveOutcome, 'accepted')
  assert.equal(bridge.getState().dirty, true)
  assert.equal(bridge.getState().status, 'unknown')
})
