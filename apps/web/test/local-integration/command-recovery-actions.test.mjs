import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { waitForDatabaseLock } from '../helpers/restricted.mjs'
import { createCommandService } from '../../server/src/modules/commands/service.ts'
import { commandHash } from '../../server/src/modules/commands/approval.ts'
const pg = await import('../../server/src/modules/commands/postgres-journal.ts').catch((e) => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw e
})
const tool = {
  name: 'docs.replace_text.v1',
  schemaVersion: 1,
  effect: 'document_write',
  executionMode: 'live_editor',
  requiresActiveEditor: true,
  requiredScopes: ['files:write'],
  maxDurationMs: 1000,
  inputSchema: {},
  outputSchema: {},
}
const owned = (f, fn, token = f.alice.token) =>
  f.transactions.withPrincipalTransaction({ kind: 'session', token }, fn)
const recovery = await import('../../server/src/modules/commands/postgres-recovery.ts').catch(
  (e) => {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw e
  },
)
const actions =
  await import('../../server/src/modules/commands/postgres-recovery-actions.ts').catch((e) => {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw e
  })
async function fixture(t) {
  assert.equal(typeof actions.createPostgresCommandRecoveryActions, 'function')
  assert.equal(typeof recovery.createPostgresCommandRecovery, 'function')
  assert.equal(typeof pg.createPostgresCommandJournal, 'function')
  const f = await fileFixture(t)
  const bytes = await docxBytes(),
    initial = (await importFile(f, f.alice.token, bytes)).file,
    editorId = randomUUID()
  const { createLeaseService } = await import('../../server/src/modules/leases/service.ts'),
    { createRevisionService } = await import('../../server/src/modules/revisions/service.ts')
  const leases = createLeaseService({ transactions: f.transactions }),
    revisions = createRevisionService({
      transactions: f.transactions,
      objects: f.objects,
      files: f.files,
    })
  const lease = await leases.acquireLease(f.alice.token, initial.fileId, { editorId })
  const envelope = {
    commandId: randomUUID(),
    fileId: initial.fileId,
    baseRevision: initial.revision,
    editorGeneration: 3,
    leaseEpoch: lease.leaseEpoch,
    argsHash: commandHash({ text: 'hello' }),
    payload: { toolName: 'docs.replace_text.v1', arguments: { text: 'hello' } },
  }
  const make = (generation = 3, token = f.alice.token, transactions = f.transactions) => {
    const adapter = pg.createPostgresCommandJournal({
      transactions,
      token,
      editorId,
      editorGeneration: generation,
    })
    return { adapter, service: createCommandService({ journal: adapter, lookupTool: () => tool }) }
  }
  return { ...f, bytes, initial, editorId, lease, leases, revisions, envelope, make }
}
async function approve(f) {
  const { service } = f.make(),
    p = await service.proposeCommand(f.envelope)
  await service.approveCommand(f.envelope, p.digest)
  return p.digest
}
async function apply(f) {
  const digest = await approve(f),
    claim = await f.make().service.beginExecution(f.envelope, digest)
  await f.make(4).service.reportApplied(f.envelope, claim.claimId, 4)
  return digest
}
async function draft(f) {
  const input = {
    fileId: f.initial.fileId,
    baseRevision: f.initial.revision,
    leaseEpoch: f.lease.leaseEpoch,
    idempotencyKey: randomUUID(),
    sourceCommandId: f.envelope.commandId,
  }
  const upload = await f.revisions.stageUpload(f.alice.token, input.fileId, {
    size: f.bytes.length,
    baseRevision: input.baseRevision,
    leaseEpoch: input.leaseEpoch,
    editorId: f.editorId,
  })
  await f.files.receiveUpload(f.alice.token, upload.uploadId, f.bytes)
  return { ...input, uploadId: upload.uploadId }
}

async function bind(f) {
  const digest = await apply(f),
    input = await draft(f)
  await f.make(4).adapter.bindCommandUpload({
    commandId: f.envelope.commandId,
    fileId: f.envelope.fileId,
    digest,
    uploadId: input.uploadId,
    sha256: f.initial.sha256,
    size: f.bytes.length,
    idempotencyKey: input.idempotencyKey,
  })
  return input
}
function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

const recoveryActions = (
  f,
  { token = f.alice.token, transactions = f.transactions, lookupTool = () => tool } = {},
) => actions.createPostgresCommandRecoveryActions({ transactions, token, lookupTool })
const abandon = (f, digest, options) =>
  recoveryActions(f, options).abandon(f.initial.fileId, f.envelope.commandId, digest)
const outcome = (f) =>
  recovery
    .createPostgresCommandRecovery({ transactions: f.transactions, token: f.alice.token })
    .lookup(f.initial.fileId, f.envelope.commandId)
for (const state of ['pending', 'applied', 'unknown-apply', 'unknown-undo'])
  test('fresh-page by-ID abandon ' + state + ' projects no capability', async (t) => {
    const f = await fixture(t)
    let digest, claim
    if (state === 'pending') digest = (await f.make().service.proposeCommand(f.envelope)).digest
    else if (state === 'unknown-apply') {
      digest = await approve(f)
      claim = await f.make().service.beginExecution(f.envelope, digest)
    } else {
      digest = await apply(f)
      if (state === 'unknown-undo') claim = await f.make(4).service.beginUndo(f.envelope)
    }
    await f.leases.takeoverLease(f.alice.token, f.initial.fileId, {
      editorId: randomUUID(),
      expectedEpoch: f.lease.leaseEpoch,
    })
    const leaseBefore = await owned(
      f,
      async (c) =>
        (
          await c.query('SELECT to_jsonb(l) AS row FROM edit_leases l WHERE file_id=$1', [
            f.initial.fileId,
          ])
        ).rows[0].row,
    )
    const result = await abandon(f, digest)
    const leaseAfter = await owned(
      f,
      async (c) =>
        (
          await c.query('SELECT to_jsonb(l) AS row FROM edit_leases l WHERE file_id=$1', [
            f.initial.fileId,
          ])
        ).rows[0].row,
    )
    assert.deepEqual(leaseAfter, leaseBefore)
    assert.equal(result.state, 'abandoned_uncommitted')
    assert.deepEqual(Object.keys(result).sort(), ['commandId', 'digest', 'fileId', 'state'])
    assert.deepEqual(await abandon(f, digest), result)
    await assert.rejects(f.make().service.beginExecution(f.envelope, digest))
    if (claim) {
      await assert.rejects(f.make(4).service.reportApplied(f.envelope, claim.claimId, 4))
      await assert.rejects(f.make(4).service.reportUndone(f.envelope, claim.claimId))
    }
  })
test('wrong observed digest, current policy, owner or session never abandon', async (t) => {
  const f = await fixture(t),
    digest = await apply(f),
    before = await outcome(f)
  const other = await f.sessions.login('alice', (await import('../helpers/identity.mjs')).password)
  for (const [digestInput, options] of [
    ['b'.repeat(64), {}],
    [digest, { lookupTool: () => ({ ...tool, maxDurationMs: 2000 }) }],
    [digest, { token: other.token }],
    [digest, { token: f.bob.token }],
  ])
    await assert.rejects(abandon(f, digestInput, options))
  assert.deepEqual(await outcome(f), before)
})
test('cancelled remains cancelled and committed is only a verified committed outcome', async (t) => {
  const f = await fixture(t),
    digest = await approve(f)
  await f.make().service.cancelCommand(f.envelope)
  assert.equal((await abandon(f, digest)).state, 'cancelled')
  const g = await fixture(t),
    input = await bind(g),
    row = await g.make(4).service.getCommandOutcome(g.envelope),
    revision = await g.revisions.commitRevision(g.alice.token, input)
  const result = await abandon(g, row.digest)
  assert.equal(result.state, 'committed')
  assert.deepEqual(result.revision, revision)
  assert.deepEqual(Object.keys(result).sort(), [
    'commandId',
    'digest',
    'fileId',
    'revision',
    'state',
  ])
})
for (const winner of ['commit', 'abandon'])
  test('by-ID ' + winner + ' winner serializes with other operation', async (t) => {
    const f = await fixture(t),
      input = await bind(f),
      row = await f.make(4).service.getCommandOutcome(f.envelope),
      ready = deferred(),
      release = deferred()
    const held = {
      withPrincipalTransaction: (credential, fn) =>
        f.transactions.withPrincipalTransaction(credential, async (c, p) => {
          const v = await fn(c, p)
          ready.resolve()
          await release.promise
          return v
        }),
    }
    const { createRevisionService } = await import('../../server/src/modules/revisions/service.ts')
    const revisions = createRevisionService({
      transactions: held,
      objects: f.objects,
      files: f.files,
    })
    const first =
      winner === 'commit'
        ? revisions.commitRevision(f.alice.token, input)
        : abandon(f, row.digest, { transactions: held })
    first.catch(() => {})
    let second
    try {
      await ready.promise
      second =
        winner === 'commit'
          ? abandon(f, row.digest)
          : f.revisions.commitRevision(f.alice.token, input)
      second.catch(() => {})
      await waitForDatabaseLock(f, 'business')
      release.resolve()
      const a = await first
      if (winner === 'commit') {
        const b = await second
        assert.equal(b.state, 'committed')
        assert.deepEqual(b.revision, a)
      } else await assert.rejects(second)
      assert.equal(
        (await outcome(f)).state,
        winner === 'commit' ? 'committed' : 'abandoned_uncommitted',
      )
    } finally {
      release.resolve()
      await Promise.allSettled([first, second].filter(Boolean))
    }
  })
for (const crash of ['before-commit', 'after-commit'])
  test('by-ID abandonment process exit ' + crash, async (t) => {
    const f = await fixture(t),
      input = await bind(f),
      row = await f.make(4).service.getCommandOutcome(f.envelope)
    const code = `import {Pool} from 'pg';import {createPrincipalTransactions} from './server/src/db/context.ts';import {createPostgresCommandRecoveryActions} from './server/src/modules/commands/postgres-recovery-actions.ts';const pool=new Pool({connectionString:process.env.ABANDON_DB});const base=createPrincipalTransactions({pool,deploymentId:process.env.ABANDON_DEPLOYMENT});const transactions=process.env.ABANDON_CRASH==='before-commit'?{withPrincipalTransaction:(credential,fn)=>base.withPrincipalTransaction(credential,async(c,p)=>{await fn(c,p);process.exit(83)})}:base;await createPostgresCommandRecoveryActions({transactions,token:process.env.ABANDON_TOKEN,lookupTool:()=>JSON.parse(process.env.ABANDON_TOOL)}).abandon(process.env.ABANDON_FILE,process.env.ABANDON_COMMAND,process.env.ABANDON_DIGEST);process.exit(84);`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        ABANDON_DB: f.urls.business,
        ABANDON_DEPLOYMENT: f.deploymentId,
        ABANDON_TOKEN: f.alice.token,
        ABANDON_TOOL: JSON.stringify(tool),
        ABANDON_FILE: f.initial.fileId,
        ABANDON_COMMAND: f.envelope.commandId,
        ABANDON_DIGEST: row.digest,
        ABANDON_CRASH: crash,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', (b) => (errors += b))
    const exit = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', resolve)
    })
    assert.equal(exit, crash === 'before-commit' ? 83 : 84, errors)
    assert.equal(
      (await outcome(f)).state,
      crash === 'before-commit' ? 'applied_uncommitted' : 'abandoned_uncommitted',
    )
    if (crash === 'after-commit') {
      assert.deepEqual(await abandon(f, row.digest), await outcome(f))
      await assert.rejects(f.revisions.commitRevision(f.alice.token, input))
    } else {
      const revision = await f.revisions.commitRevision(f.alice.token, input)
      assert.deepEqual((await abandon(f, row.digest)).revision, revision)
    }
  })

test('revocation committed ahead of waiting by-ID abandonment denies authority', async (t) => {
  const f = await fixture(t),
    digest = await apply(f),
    ready = deferred(),
    release = deferred()
  const { createSessionService } = await import('../../server/src/modules/auth/sessions.ts')
  const controlled = {
    ...f.db,
    transaction: (operation) =>
      f.db.transaction(async (c) => {
        const value = await operation(c)
        const s = (
          await c.query('SELECT revoked_at FROM sessions WHERE id=$1', [f.alice.sessionId])
        ).rows[0]
        if (s.revoked_at) {
          ready.resolve()
          await release.promise
        }
        return value
      }),
  }
  const sessions = createSessionService({
      db: controlled,
      accounts: f.accounts,
      deploymentId: f.deploymentId,
    }),
    revoke = sessions.revoke(f.alice.token, f.alice.sessionId)
  let recovering
  try {
    await ready.promise
    recovering = abandon(f, digest)
    recovering.catch(() => {})
    await waitForDatabaseLock(f, 'business')
    release.resolve()
    await revoke
    await assert.rejects(recovering, { statusCode: 401 })
  } finally {
    release.resolve()
    await Promise.allSettled([revoke, recovering].filter(Boolean))
  }
})
