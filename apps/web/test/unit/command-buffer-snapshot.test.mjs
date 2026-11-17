import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createCommandSaveCoordinator } from '../../../../packages/browser-host/src/command-save.ts'
test('save snapshots only Buffer view bytes before asynchronous hash and stage', async () => {
  const source = Buffer.from([7, 8, 9, 10]),
    bytes = source.subarray(1, 3),
    expected = new Uint8Array([8, 9]),
    sha256 = createHash('sha256').update(expected).digest('hex')
  const envelope = {
    commandId: 'command',
    fileId: 'file',
    baseRevision: 'r1',
    leaseEpoch: 1,
    editorGeneration: 0,
  }
  const c = createCommandSaveCoordinator({
    current: () => ({ ...envelope, editorGeneration: 1 }),
    serialize: async () => bytes,
    host: {
      stageSave: async (b) => {
        source.fill(0)
        assert.deepEqual(new Uint8Array(b), expected)
        return { uploadId: 'upload' }
      },
      commitSave: async (b) => {
        assert.equal(b.sourceCommandId, 'command')
        return { fileId: 'file', revision: 'r2', sha256, size: 2 }
      },
    },
    bind: async (b) => assert.equal(b.sha256, sha256),
    verifyCommitted: async () => true,
  })
  assert.equal((await c.save(envelope, 'digest', 1)).revision, 'r2')
})
