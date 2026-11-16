import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../../../../packages/browser-host/src/tool-executor.ts'
const envelope = {
  commandId: 'c',
  fileId: 'f',
  baseRevision: 'r',
  editorGeneration: 1,
  leaseEpoch: 1,
  argsHash: 'a'.repeat(64),
  payload: { toolName: 'replace', arguments: { text: 'hello' } },
}
function fixture() {
  let generation = 1,
    calls = 0,
    state = 'approved',
    receiptFailure = false
  const undoToken = {}
  const journal = {
    async beginExecution() {
      if (state !== 'approved') throw Error('no retry')
      state = 'unknown_outcome'
      return { envelope, claimId: 'claim', state }
    },
    async reportApplied(e, c, g) {
      if (receiptFailure) throw Error('lost reply')
      state = 'applied_uncommitted'
      return { state }
    },
    async beginUndo() {
      if (state !== 'applied_uncommitted') throw Error('no undo')
      state = 'unknown_outcome'
      return { envelope, claimId: 'undo', appliedGeneration: 2 }
    },
    async reportUndone() {
      state = 'cancelled'
      return { state }
    },
  }
  const editor = {
    current: () => ({
      fileId: 'f',
      baseRevision: 'r',
      editorGeneration: generation,
      leaseEpoch: 1,
    }),
    applyBatch: () => {
      calls++
      generation++
      return { generation, undoToken }
    },
    undoBatch: (token) => {
      assert.equal(token, undoToken)
      calls++
      generation++
      return generation
    },
  }
  assert.equal(typeof api.createToolExecutor, 'function')
  const executor = api.createToolExecutor({ journal, editor })
  return {
    executor,
    journal,
    editor,
    get calls() {
      return calls
    },
    get state() {
      return state
    },
    edit: () => generation++,
    loseReceipt: () => (receiptFailure = true),
  }
}
test('approved command applies exactly one batch and duplicate invocation cannot replay', async () => {
  const f = fixture()
  assert.equal(
    (await f.executor.executeAuthorizedTool(envelope, 'digest')).status,
    'applied_uncommitted',
  )
  await assert.rejects(() =>
    f.executor.executeAuthorizedTool(envelope, 'digest'),
  )
  assert.equal(f.calls, 1)
})
test('edits arriving during server claim are rejected before editor mutation', async () => {
  const f = fixture()
  const begin = f.journal.beginExecution
  f.journal.beginExecution = async () => {
    const claim = await begin()
    f.edit()
    return claim
  }
  assert.equal(
    (await f.executor.executeAuthorizedTool(envelope, 'digest')).status,
    'conflict',
  )
  assert.equal(f.calls, 0)
  assert.equal(f.state, 'unknown_outcome')
})
test('lost applied receipt preserves unknown and does not replay after caller retries', async () => {
  const f = fixture()
  f.loseReceipt()
  assert.equal(
    (await f.executor.executeAuthorizedTool(envelope, 'digest')).status,
    'unknown_outcome',
  )
  await assert.rejects(() =>
    f.executor.executeAuthorizedTool(envelope, 'digest'),
  )
  assert.equal(f.calls, 1)
})
test('undo is batch-specific and cannot overwrite subsequent input', async () => {
  const f = fixture()
  await f.executor.executeAuthorizedTool(envelope, 'digest')
  f.edit()
  assert.equal((await f.executor.undoCommand(envelope)).status, 'conflict')
  assert.equal(f.calls, 1)
})
test('unchanged applied batch can be undone once, without generic editor history', async () => {
  const f = fixture()
  await f.executor.executeAuthorizedTool(envelope, 'digest')
  assert.equal((await f.executor.undoCommand(envelope)).status, 'cancelled')
  await assert.rejects(() => f.executor.undoCommand(envelope))
  assert.equal(f.calls, 2)
})

test('real command service gate cannot execute a provider candidate without explicit approval', async () => {
  const { createCommandService } =
    await import('../../server/src/modules/commands/service.ts')
  const { commandHash } =
    await import('../../server/src/modules/commands/approval.ts')
  let row = null,
    generation = 1,
    applications = 0
  const e = { ...envelope, argsHash: commandHash(envelope.payload.arguments) }
  const gate = createCommandService({
    journal: {
      async withAuthorizedCommand(fileId, id, fn) {
        const r = await fn(
          {
            authority: {
              deploymentId: 'd',
              userId: 'u',
              sessionId: 's',
              fileId: 'f',
              baseRevision: 'r',
              editorGeneration: generation,
              leaseEpoch: 1,
              scopes: ['files:write'],
            },
          },
          structuredClone(row),
        )
        if (r.next) row = structuredClone(r.next)
        return structuredClone(r.value)
      },
    },
    lookupTool: () => ({
      name: 'replace',
      schemaVersion: 1,
      effect: 'document_write',
      executionMode: 'live_editor',
      requiresActiveEditor: true,
      requiredScopes: ['files:write'],
      maxDurationMs: 1000,
      inputSchema: {},
      outputSchema: {},
    }),
  })
  const executor = api.createToolExecutor({
    journal: gate,
    editor: {
      current: () => ({
        fileId: 'f',
        baseRevision: 'r',
        editorGeneration: generation,
        leaseEpoch: 1,
      }),
      applyBatch: () => {
        applications++
        return { generation: ++generation, undoToken: 'inverse' }
      },
      undoBatch: () => ++generation,
    },
  })
  const proposal = await gate.proposeCommand(e)
  await assert.rejects(() => executor.executeAuthorizedTool(e, proposal.digest))
  assert.equal(applications, 0)
  await gate.approveCommand(e, proposal.digest)
  assert.equal(
    (await executor.executeAuthorizedTool(e, proposal.digest)).status,
    'applied_uncommitted',
  )
  assert.equal((await gate.getCommandOutcome(e)).state, 'applied_uncommitted')
  assert.equal((await executor.undoCommand(e)).status, 'cancelled')
  assert.equal(applications, 1)
})

test('disposing while an execution claim is pending prevents late editor application', async () => {
  const f = fixture(),
    begin = f.journal.beginExecution
  f.journal.beginExecution = async () => {
    const claim = await begin()
    f.executor.dispose()
    return claim
  }
  assert.equal(
    (await f.executor.executeAuthorizedTool(envelope, 'digest')).status,
    'conflict',
  )
  assert.equal(f.calls, 0)
  await assert.rejects(() =>
    f.executor.executeAuthorizedTool(envelope, 'digest'),
  )
})
