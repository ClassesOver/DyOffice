import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as module from '../../../../packages/browser-host/src/command-save.ts'
const e = {
  commandId: 'cmd',
  fileId: 'file',
  baseRevision: 'r1',
  leaseEpoch: 1,
  editorGeneration: 3,
}
function fixture(options = {}) {
  let state = { ...e, editorGeneration: 4 },
    calls = [],
    lose = true
  const bytes = new Uint8Array([1, 2]),
    hash = createHash('sha256').update(bytes).digest('hex')
  const host = {
    stageSave: async () => {
      calls.push('stage')
      return { uploadId: 'upload' }
    },
    commitSave: async (input) => {
      calls.push(structuredClone(input))
      if (lose && options.lose) {
        lose = false
        throw Error('lost response')
      }
      return { fileId: 'file', revision: 'r2', sha256: hash, size: 2 }
    },
  }
  host.reconcile = async () => {
    const prior = frozenInput ?? calls.find((x) => x?.sourceCommandId)
    return host.commitSave(prior)
  }
  let frozenInput
  const originalCommit = host.commitSave
  host.commitSave = async (input) => {
    frozenInput = input
    return originalCommit(input)
  }
  const c = module.createCommandSaveCoordinator({
    verifyCommitted: async () => true,
    host,
    current: () => state,
    serialize: async () => {
      if (options.edit) state.editorGeneration++
      return bytes
    },
    bind: async (binding) => calls.push(binding),
  })
  return { c, calls, state }
}
test('save adapter exists and binds exact snapshot before T06 source command commit', async () => {
  assert.equal(typeof module.createCommandSaveCoordinator, 'function')
  const f = fixture()
  assert.equal((await f.c.save(e, 'digest', 4)).revision, 'r2')
  assert.equal(f.calls[0], 'stage')
  assert.equal(f.calls[1].commandId, 'cmd')
  assert.equal(f.calls[1].uploadId, f.calls[2].uploadId)
  assert.equal(f.calls[1].idempotencyKey, f.calls[2].idempotencyKey)
  assert.equal(f.calls[2].sourceCommandId, 'cmd')
})
test('serialization edit rejects before stage or binding', async () => {
  const f = fixture({ edit: true })
  await assert.rejects(f.c.save(e, 'digest', 4))
  assert.deepEqual(f.calls, [])
})
test('lost commit response reconciles identical tuple without staging or binding again', async () => {
  const f = fixture({ lose: true })
  await assert.rejects(f.c.save(e, 'digest', 4))
  await assert.rejects(f.c.save(e, 'digest', 4))
  assert.equal(f.c.hasPending(), true)
  await f.c.reconcile()
  assert.deepEqual(f.calls[2], f.calls[3])
  assert.equal(f.calls.length, 4)
  assert.equal(f.c.hasPending(), false)
})
test('dispose denies save and reconcile', async () => {
  const f = fixture()
  f.c.dispose()
  await assert.rejects(f.c.save(e, 'digest', 4))
  await assert.rejects(f.c.reconcile())
  assert.deepEqual(f.calls, [])
})
test('lost bind response retains identical upload binding for reconciliation', async () => {
  let bindings = [],
    commits = 0
  let first = true
  const b = new Uint8Array([7]),
    hash = createHash('sha256').update(b).digest('hex')
  const c = module.createCommandSaveCoordinator({
    verifyCommitted: async () => true,
    current: () => ({ ...e, editorGeneration: 4 }),
    serialize: async () => b,
    host: {
      stageSave: async () => ({ uploadId: 'same' }),
      commitSave: async () => {
        commits++
        return { fileId: 'file', revision: 'r2', sha256: hash, size: 1 }
      },
    },
    bind: async (x) => {
      bindings.push(x)
      if (first) {
        first = false
        throw Error('lost')
      }
    },
  })
  await assert.rejects(c.save(e, 'digest', 4))
  assert.equal(c.hasPending(), true)
  await c.reconcile()
  assert.deepEqual(bindings[0], bindings[1])
  assert.equal(commits, 1)
})
test('dispose during durable commit prevents a late completion signal', async () => {
  let entered, release
  const ready = new Promise((r) => (entered = r)),
    bytes = new Uint8Array([8]),
    sha256 = createHash('sha256').update(bytes).digest('hex')
  const c = module.createCommandSaveCoordinator({
    verifyCommitted: async () => true,
    current: () => ({ ...e, editorGeneration: 4 }),
    serialize: async () => bytes,
    bind: async () => {},
    host: {
      stageSave: async () => ({ uploadId: 'u' }),
      commitSave: async () => {
        entered()
        await new Promise((r) => (release = r))
        return { fileId: 'file', revision: 'r2', sha256, size: 1 }
      },
    },
  })
  const saving = c.save(e, 'digest', 4)
  await ready
  c.dispose()
  release()
  await assert.rejects(saving)
})
test('definite commit rejection cannot reconcile an old matching base or unrelated revision as command success', async () => {
  const bytes = new Uint8Array([5]),
    sha256 = createHash('sha256').update(bytes).digest('hex')
  for (const revision of ['r1', 'unrelated']) {
    const c = module.createCommandSaveCoordinator({
      current: () => ({ ...e, editorGeneration: 4 }),
      serialize: async () => bytes,
      bind: async () => {},
      verifyCommitted: async () => false,
      host: {
        stageSave: async () => ({ uploadId: 'u' }),
        commitSave: async () => {
          throw Object.assign(Error('conflict'), { status: 409 })
        },
        reconcile: async () => ({ fileId: 'file', revision, sha256, size: 1 }),
      },
    })
    await assert.rejects(c.save(e, 'digest', 4))
    await assert.rejects(c.reconcile())
    assert.equal(c.hasPending(), true)
  }
})
test('save coordinator refuses construction without a durable command verifier', () => {
  assert.throws(
    () =>
      module.createCommandSaveCoordinator({
        host: {},
        current: () => e,
        serialize: async () => new Uint8Array(),
        bind: async () => {},
      }),
    /verifier/,
  )
})
