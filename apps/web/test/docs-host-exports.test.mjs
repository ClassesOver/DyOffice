import { test } from 'node:test'
import assert from 'node:assert/strict'

test('projection and session file hosts remain importable without mounting a browser editor', async () => {
  const { mountDocsEditor, createSessionFileHost } = await import('../../../packages/browser-host/src/files.ts')
  assert.equal(typeof mountDocsEditor, 'function')
  const host = createSessionFileHost({
    fetchImpl: async () => { throw new Error('Importing or creating a host must not start a request') },
  })
  assert.equal(typeof host.open, 'function')
  assert.equal(typeof host.save, 'function')
  host.dispose()
})
