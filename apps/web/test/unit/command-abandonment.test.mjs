import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommandService } from '../../server/src/modules/commands/service.ts'
import { commandHash } from '../../server/src/modules/commands/approval.ts'
function fixture(toolName = 'docs.replace_text.v1') {
  const tool = {
    name: toolName,
    schemaVersion: 1,
    effect: 'document_write',
    executionMode: 'live_editor',
    requiresActiveEditor: true,
    requiredScopes: ['files:write'],
    maxDurationMs: 1000,
    inputSchema: {},
    outputSchema: {},
  }
  const args = { text: 'New' },
    envelope = {
      commandId: 'command',
      fileId: 'file',
      baseRevision: 'r1',
      editorGeneration: 3,
      leaseEpoch: 4,
      argsHash: commandHash(args),
      payload: { toolName, arguments: args },
    }
  let row = null,
    authority = {
      deploymentId: 'd',
      userId: 'u',
      sessionId: 's',
      fileId: 'file',
      baseRevision: 'r1',
      editorGeneration: 3,
      leaseEpoch: 4,
      scopes: ['files:write'],
    },
    verify = async () => false,
    verifyCalls = 0
  const journal = {
    async withAuthorizedCommand(file, id, fn) {
      const out = await fn(
        {
          authority: structuredClone(authority),
          nowMs: 1,
          verifyCommit: async (...args) => {
            verifyCalls++
            return verify(...args)
          },
        },
        structuredClone(row),
      )
      if (out.next) row = structuredClone(out.next)
      return structuredClone(out.value)
    },
  }
  const service = createCommandService({ journal, lookupTool: () => tool })
  return {
    service,
    envelope,
    tool,
    authority,
    get row() {
      return row
    },
    set row(x) {
      row = x
    },
    setVerify(fn) {
      verify = fn
    },
    get verifyCalls() {
      return verifyCalls
    },
  }
}
async function stage(f, state) {
  let row = await f.service.proposeCommand(f.envelope)
  if (state === 'pending_approval') return row
  row = await f.service.approveCommand(f.envelope, row.digest)
  if (state === 'approved') return row
  row = await f.service.beginExecution(f.envelope, row.digest)
  if (state === 'apply_unknown') return row
  row = await f.service.reportApplied(f.envelope, row.claimId, 4)
  if (state === 'applied_uncommitted') return row
  f.authority.editorGeneration = 4
  return f.service.beginUndo(f.envelope)
}
for (const state of [
  'pending_approval',
  'approved',
  'apply_unknown',
  'applied_uncommitted',
  'undo_unknown',
])
  test('abandon fences ' + state + ' without live lease and preserves all fields', async () => {
    const f = fixture(),
      prior = await stage(f, state)
    f.authority.leaseEpoch = 0
    f.authority.baseRevision = 'new-head'
    const result = await f.service.abandonCommand(f.envelope, prior.digest)
    assert.deepEqual(result, { ...prior, state: 'abandoned_uncommitted' })
    assert.deepEqual(await f.service.abandonCommand(f.envelope, prior.digest), result)
    assert.deepEqual(f.row, result)
  })
test('wrong digest/tool/descriptor/current authority fail without changing state', async () => {
  for (const change of ['digest', 'tool', 'descriptor', 'scope', 'session']) {
    const f = fixture(change === 'tool' ? 'other.writer' : 'docs.replace_text.v1'),
      prior = await stage(f, 'approved')
    if (change === 'descriptor') f.tool.executionMode = 'headless'
    if (change === 'scope') f.authority.scopes = []
    if (change === 'session') f.authority.sessionId = ''
    await assert.rejects(() =>
      f.service.abandonCommand(f.envelope, change === 'digest' ? 'bad' : prior.digest),
    )
    assert.deepEqual(f.row, prior)
  }
})
test('cancelled stays cancelled and no missing command may be fabricated', async () => {
  const f = fixture()
  await assert.rejects(() => f.service.abandonCommand(f.envelope, 'bad'))
  const p = await stage(f, 'approved')
  const row = await f.service.cancelCommand(f.envelope)
  assert.deepEqual(await f.service.abandonCommand(f.envelope, p.digest), row)
})
test('committed returns only after exact receipt verification, never changes record', async () => {
  const f = fixture(),
    row = await stage(f, 'applied_uncommitted'),
    revision = { fileId: 'file', revision: 'r2', sha256: 'a'.repeat(64), size: 10 }
  f.row = { ...row, state: 'committed', revision }
  await assert.rejects(() => f.service.abandonCommand(f.envelope, row.digest))
  f.setVerify(async (record, ref) => {
    assert.deepEqual(record, f.row)
    assert.deepEqual(ref, revision)
    return true
  })
  assert.deepEqual(await f.service.abandonCommand(f.envelope, row.digest), f.row)
  assert.equal(f.verifyCalls, 2)
  f.setVerify(async () => 1)
  await assert.rejects(() => f.service.abandonCommand(f.envelope, row.digest))
})
test('all old execution, report, undo and commit methods reject after abandonment', async () => {
  const f = fixture(),
    p = await stage(f, 'applied_uncommitted'),
    row = await f.service.abandonCommand(f.envelope, p.digest)
  for (const fn of [
    () => f.service.approveCommand(f.envelope, p.digest),
    () => f.service.beginExecution(f.envelope, p.digest),
    () => f.service.reportApplied(f.envelope, p.claimId, 5),
    () => f.service.beginUndo(f.envelope),
    () => f.service.reportUndone(f.envelope, p.claimId),
    () =>
      f.service.recordCommitted(f.envelope, {
        fileId: 'file',
        revision: 'r2',
        sha256: 'a'.repeat(64),
        size: 10,
      }),
  ])
    await assert.rejects(fn)
  assert.deepEqual(f.row, row)
})
