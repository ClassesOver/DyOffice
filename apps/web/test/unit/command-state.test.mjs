import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as api from '../../server/src/modules/commands/service.ts'
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const descriptor = {
  name: 'replace_text',
  schemaVersion: 1,
  effect: 'document_write',
  executionMode: 'live_editor',
  requiresActiveEditor: true,
  requiredScopes: ['files:write'],
  maxDurationMs: 1000,
  inputSchema: {},
  outputSchema: {},
}
function fixture() {
  let authority = {
    deploymentId: 'deployment',
    userId: 'alice',
    sessionId: 'session',
    fileId: 'file',
    baseRevision: 'r1',
    editorGeneration: 3,
    leaseEpoch: 4,
    scopes: ['files:write'],
  }
  let now = 1000,
    beforeLock = () => {}
  const rows = new Map()
  let tail = Promise.resolve()
  const journal = {
    withAuthorizedCommand(fileId, id, fn) {
      const run = tail.then(async () => {
        await beforeLock()
        const scope = {
          deploymentId: authority.deploymentId,
          userId: authority.userId,
          sessionId: authority.sessionId,
        }
        const key = JSON.stringify([scope, id])
        const { next, value } = await fn(
          {
            authority: structuredClone(authority),
            verifyCommit: async (record, revision) =>
              revision.revision === 'r2' && record.envelope.commandId === 'command',
          },
          structuredClone(rows.get(key) ?? null),
        )
        if (next) rows.set(key, structuredClone(next))
        return structuredClone(value)
      })
      tail = run.catch(() => {})
      return run
    },
  }

  assert.equal(typeof api.createCommandService, 'function')
  const service = api.createCommandService({
    journal,
    lookupTool: () => structuredClone(descriptor),
    now: () => now,
  })
  const envelope = {
    commandId: 'command',
    fileId: 'file',
    baseRevision: 'r1',
    editorGeneration: 3,
    leaseEpoch: 4,
    argsHash: hash({ text: 'hello' }),
    payload: { toolName: 'replace_text', arguments: { text: 'hello' } },
  }
  return {
    service,
    envelope,
    authority,
    rows,
    setAuthority: (x) => (authority = { ...authority, ...x }),
    advance: () => (now += 60001),
    beforeLock: (fn) => (beforeLock = fn),
  }
}
async function approved(f) {
  const proposal = await f.service.proposeCommand(f.envelope)
  return f.service.approveCommand(f.envelope, proposal.digest)
}
test('changed arguments or envelope cannot reuse approval or command identity', async () => {
  const f = fixture()
  const p = await approved(f)
  await assert.rejects(() =>
    f.service.proposeCommand({
      ...f.envelope,
      payload: { toolName: 'replace_text', arguments: { text: 'bye' } },
    }),
  )
  await assert.rejects(() =>
    f.service.beginExecution({ ...f.envelope, editorGeneration: 4 }, p.digest),
  )
  assert.equal((await f.service.getCommandOutcome(f.envelope)).state, 'approved')
})
test('stale editor generation, base revision, lease and missing scopes fail closed', async () => {
  for (const change of [
    { editorGeneration: 4 },
    { baseRevision: 'r2' },
    { leaseEpoch: 5 },
    { scopes: [] },
  ]) {
    const f = fixture()
    const p = await approved(f)
    f.setAuthority(change)
    await assert.rejects(() => f.service.beginExecution(f.envelope, p.digest))
  }
})
test('duplicate concurrent execution claims admit exactly one and later lookup sees unknown', async () => {
  const f = fixture()
  const p = await approved(f)
  const results = await Promise.allSettled([
    f.service.beginExecution(f.envelope, p.digest),
    f.service.beginExecution(f.envelope, p.digest),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal((await f.service.getCommandOutcome(f.envelope)).state, 'unknown_outcome')
  await assert.rejects(() => f.service.beginExecution(f.envelope, p.digest))
})
test('approval expires and one session cannot see another session command', async () => {
  const f = fixture()
  const p = await approved(f)
  f.advance()
  await assert.rejects(() => f.service.beginExecution(f.envelope, p.digest))
  f.setAuthority({ sessionId: 'other' })
  assert.equal(await f.service.getCommandOutcome(f.envelope), null)
})
test('commit requires verified T06 receipt and cancellation cannot undo committed effects', async () => {
  const f = fixture()
  const p = await approved(f),
    claim = await f.service.beginExecution(f.envelope, p.digest)
  await f.service.reportApplied(f.envelope, claim.claimId, 4)
  const good = {
    fileId: 'file',
    revision: 'r2',
    sha256: 'a'.repeat(64),
    size: 10,
  }
  await assert.rejects(() => f.service.recordCommitted(f.envelope, { ...good, revision: 'forged' }))
  assert.equal((await f.service.recordCommitted(f.envelope, good)).state, 'committed')
  assert.equal((await f.service.cancelCommand(f.envelope)).state, 'committed')
})
test('cancelling an ambiguous application does not claim rollback and newer edits block undo', async () => {
  const f = fixture()
  const p = await approved(f),
    claim = await f.service.beginExecution(f.envelope, p.digest)
  assert.equal((await f.service.cancelCommand(f.envelope)).state, 'unknown_outcome')
  await f.service.reportApplied(f.envelope, claim.claimId, 4)
  f.setAuthority({ editorGeneration: 5 })
  await assert.rejects(() => f.service.beginUndo(f.envelope))
  assert.equal((await f.service.getCommandOutcome(f.envelope)).state, 'applied_uncommitted')
})
test('registry policy change after approval invalidates dispatch', async () => {
  const f = fixture()
  const p = await approved(f)
  descriptor.schemaVersion++
  try {
    await assert.rejects(() => f.service.beginExecution(f.envelope, p.digest))
  } finally {
    descriptor.schemaVersion--
  }
})
test('bounded canonical JSON rejects accessors, cyclic, unsupported and non-finite inputs', async () => {
  const f = fixture()
  for (const args of [() => {}, NaN, undefined, new Date(), { nested: Infinity }])
    await assert.rejects(() =>
      f.service.proposeCommand({
        ...f.envelope,
        payload: { toolName: 'replace_text', arguments: args },
      }),
    )
  let invoked = false
  const value = {}
  Object.defineProperty(value, 'secret', {
    enumerable: true,
    get() {
      invoked = true
      return 'value'
    },
  })
  await assert.rejects(() =>
    f.service.proposeCommand({
      ...f.envelope,
      payload: { toolName: 'replace_text', arguments: value },
    }),
  )
  assert.equal(invoked, false)
})
test('lease revoked while awaiting journal lock cannot claim apply or undo', async () => {
  for (const operation of ['apply', 'undo']) {
    const f = fixture(),
      p = await approved(f)
    if (operation === 'undo') {
      const claim = await f.service.beginExecution(f.envelope, p.digest)
      await f.service.reportApplied(f.envelope, claim.claimId, 4)
      f.setAuthority({ editorGeneration: 4 })
    }
    f.beforeLock(() => f.setAuthority({ leaseEpoch: 5 }))
    await assert.rejects(() =>
      operation === 'apply'
        ? f.service.beginExecution(f.envelope, p.digest)
        : f.service.beginUndo(f.envelope),
    )
    assert.equal(
      (await f.service.getCommandOutcome(f.envelope)).state,
      operation === 'apply' ? 'approved' : 'applied_uncommitted',
    )
  }
})

test('committed outcome cannot trust a row without original writer provenance', async () => {
  const f = fixture()
  await approved(f)
  const [key, row] = [...f.rows][0]
  const revision = { fileId: 'file', revision: 'forged', sha256: 'a'.repeat(64), size: 10 }
  f.rows.set(key, { ...row, state: 'committed', revision })
  await assert.rejects(() => f.service.getCommandOutcome(f.envelope), /receipt/)
  assert.equal(f.rows.get(key).revision.revision, 'forged')
  f.rows.set(key, { ...row, state: 'committed', revision: { ...revision, revision: 'r2' } })
  assert.equal((await f.service.getCommandOutcome(f.envelope)).revision.revision, 'r2')
})
