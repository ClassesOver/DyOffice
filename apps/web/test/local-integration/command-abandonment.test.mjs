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
async function fixture(t) {
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
for (const state of ['pending', 'approved', 'unknown-apply', 'applied', 'unknown-undo'])
  test('real PG abandon fences ' + state, async (t) => {
    const f = await fixture(t),
      p = await f.make().service.proposeCommand(f.envelope)
    let claim
    if (state !== 'pending') await f.make().service.approveCommand(f.envelope, p.digest)
    if (['unknown-apply', 'applied', 'unknown-undo'].includes(state))
      claim = await f.make().service.beginExecution(f.envelope, p.digest)
    if (['applied', 'unknown-undo'].includes(state))
      await f.make(4).service.reportApplied(f.envelope, claim.claimId, 4)
    if (state === 'unknown-undo') claim = await f.make(4).service.beginUndo(f.envelope)
    const before = await f.make(4).service.getCommandOutcome(f.envelope),
      row = await f.make(4).service.abandonCommand(f.envelope, p.digest)
    assert.equal(row.state, 'abandoned_uncommitted')
    assert.equal(row.claimId, before.claimId)
    assert.equal(row.operation, before.operation)
    assert.deepEqual(await f.make(4).service.abandonCommand(f.envelope, p.digest), row)
    await assert.rejects(f.make().service.beginExecution(f.envelope, p.digest))
    await assert.rejects(f.make(4).service.beginUndo(f.envelope))
    if (claim) {
      await assert.rejects(f.make(4).service.reportApplied(f.envelope, claim.claimId, 4))
      await assert.rejects(f.make(4).service.reportUndone(f.envelope, claim.claimId))
    }
    assert.equal(
      (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
      f.initial.revision,
    )
  })
test('bound upload tombstone survives abandonment and source omission/replacement cannot publish', async (t) => {
  const f = await fixture(t),
    input = await bind(f),
    before = await f.make(4).service.getCommandOutcome(f.envelope)
  await f.make(4).service.abandonCommand(f.envelope, before.digest)
  const binding = await owned(f, (c) =>
    c.query('SELECT upload_id,idempotency_key FROM command_upload_bindings WHERE command_id=$1', [
      f.envelope.commandId,
    ]),
  )
  assert.equal(binding.rowCount, 1)
  assert.equal(binding.rows[0].upload_id, input.uploadId)
  for (const sourceCommandId of [f.envelope.commandId, undefined, randomUUID()])
    await assert.rejects(f.revisions.commitRevision(f.alice.token, { ...input, sourceCommandId }))
  await assert.rejects(
    f
      .make(4)
      .adapter.bindCommandUpload({
        commandId: f.envelope.commandId,
        fileId: f.initial.fileId,
        digest: before.digest,
        uploadId: input.uploadId,
        sha256: f.initial.sha256,
        size: f.bytes.length,
        idempotencyKey: input.idempotencyKey,
      }),
  )
  assert.equal(
    (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
    f.initial.revision,
  )
})
for (const winner of ['commit', 'abandon'])
  test('deterministic database lock winner ' + winner, async (t) => {
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
    const heldRevisions = createRevisionService({
      transactions: held,
      objects: f.objects,
      files: f.files,
    })
    const first =
      winner === 'commit'
        ? heldRevisions.commitRevision(f.alice.token, input)
        : f.make(4, f.alice.token, held).service.abandonCommand(f.envelope, row.digest)
    first.catch(() => {})
    let second
    try {
      await ready.promise
      second =
        winner === 'commit'
          ? f.make(4).service.abandonCommand(f.envelope, row.digest)
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
      const end = await f.make(4).service.getCommandOutcome(f.envelope)
      assert.equal(end.state, winner === 'commit' ? 'committed' : 'abandoned_uncommitted')
      assert.equal(
        (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
        winner === 'commit' ? a.revision : f.initial.revision,
      )
    } finally {
      release.resolve()
      await Promise.allSettled([first, second].filter(Boolean))
    }
  })
test('old lease can be fenced without takeover but cross-owner session cannot abandon', async (t) => {
  const f = await fixture(t),
    digest = await apply(f)
  await assert.rejects(f.make(4, f.bob.token).service.abandonCommand(f.envelope, digest))
  const other = await f.sessions.login('alice', (await import('../helpers/identity.mjs')).password)
  await assert.rejects(f.make(4, other.token).service.abandonCommand(f.envelope, digest))
  const lease = await f.leases.takeoverLease(f.alice.token, f.initial.fileId, {
    editorId: randomUUID(),
    expectedEpoch: f.lease.leaseEpoch,
  })
  assert.equal(
    (await f.make(4).service.abandonCommand(f.envelope, digest)).state,
    'abandoned_uncommitted',
  )
  const current = await owned(f, (c) =>
    c.query('SELECT lease_epoch FROM edit_leases WHERE file_id=$1', [f.initial.fileId]),
  )
  assert.equal(Number(current.rows[0].lease_epoch), lease.leaseEpoch)
})
test('revocation committed ahead of waiting abandonment denies authority', async (t) => {
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
  let abandoning
  try {
    await ready.promise
    abandoning = f.make(4).service.abandonCommand(f.envelope, digest)
    abandoning.catch(() => {})
    await waitForDatabaseLock(f, 'business')
    release.resolve()
    await revoke
    await assert.rejects(abandoning, { statusCode: 401 })
  } finally {
    release.resolve()
    await Promise.allSettled([revoke, abandoning].filter(Boolean))
  }
})
for (const crash of ['before-commit', 'after-commit'])
  test('abandon ' + crash + ' process exit preserves atomic state', async (t) => {
    const f = await fixture(t),
      input = await bind(f),
      row = await f.make(4).service.getCommandOutcome(f.envelope)
    const code = `import {Pool} from 'pg';import {createPrincipalTransactions} from './server/src/db/context.ts';import {createPostgresCommandJournal} from './server/src/modules/commands/postgres-journal.ts';import {createCommandService} from './server/src/modules/commands/service.ts';const pool=new Pool({connectionString:process.env.ABANDON_DB});const base=createPrincipalTransactions({pool,deploymentId:process.env.ABANDON_DEPLOYMENT});const transactions=process.env.ABANDON_CRASH==='before-commit'?{withPrincipalTransaction:(credential,fn)=>base.withPrincipalTransaction(credential,async(c,p)=>{await fn(c,p);process.exit(83)})}:base;const journal=createPostgresCommandJournal({transactions,token:process.env.ABANDON_TOKEN,editorId:process.env.ABANDON_EDITOR,editorGeneration:4});await createCommandService({journal,lookupTool:()=>JSON.parse(process.env.ABANDON_TOOL)}).abandonCommand(JSON.parse(process.env.ABANDON_ENVELOPE),process.env.ABANDON_DIGEST);process.exit(84);`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        ABANDON_DB: f.urls.business,
        ABANDON_DEPLOYMENT: f.deploymentId,
        ABANDON_TOKEN: f.alice.token,
        ABANDON_EDITOR: f.editorId,
        ABANDON_TOOL: JSON.stringify(tool),
        ABANDON_ENVELOPE: JSON.stringify(f.envelope),
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
    const end = await f.make(4).service.getCommandOutcome(f.envelope)
    assert.equal(
      end.state,
      crash === 'before-commit' ? 'applied_uncommitted' : 'abandoned_uncommitted',
    )
    assert.equal(
      (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
      f.initial.revision,
    )
    if (crash === 'after-commit') {
      assert.deepEqual(await f.make(4).service.abandonCommand(f.envelope, row.digest), end)
      await assert.rejects(f.revisions.commitRevision(f.alice.token, input))
    } else {
      const saved = await f.revisions.commitRevision(f.alice.token, input)
      assert.deepEqual(
        (await f.make(4).service.abandonCommand(f.envelope, row.digest)).revision,
        saved,
      )
    }
  })
test('SQL cannot forge abandonment identity or resurrect tombstone, and direct insert binding is fenced', async (t) => {
  const f = await fixture(t),
    digest = await apply(f),
    input = await draft(f)
  const mutate = (fields) =>
    owned(f, (c) =>
      c.query('UPDATE command_journal SET record=record||$1::jsonb WHERE command_id=$2', [
        JSON.stringify(fields),
        f.envelope.commandId,
      ]),
    )
  await assert.rejects(mutate({ state: 'abandoned_uncommitted', claimId: randomUUID() }), {
    code: '23514',
  })
  await assert.rejects(mutate({ state: 'abandoned_uncommitted', approvedUntil: null }), {
    code: '23514',
  })
  await f.make(4).service.abandonCommand(f.envelope, digest)
  await assert.rejects(mutate({ state: 'applied_uncommitted' }), { code: '23514' })
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query(
          'INSERT INTO command_upload_bindings(deployment_id,owner_id,session_id,command_id,file_id,upload_id,editor_id,idempotency_key,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            f.deploymentId,
            f.alice.user.id,
            f.alice.sessionId,
            f.envelope.commandId,
            f.initial.fileId,
            input.uploadId,
            f.editorId,
            input.idempotencyKey,
            f.initial.sha256,
            f.bytes.length,
          ],
        ),
      ),
    { code: '23514' },
  )
  const rows = await owned(f, (c) =>
    c.query('SELECT state FROM command_journal WHERE command_id=$1', [f.envelope.commandId]),
  )
  assert.equal(rows.rows[0].state, 'abandoned_uncommitted')
})
test('SQL refuses abandonment of other tool names and committed receipts', async (t) => {
  const f = await fixture(t),
    other = {
      ...f.envelope,
      commandId: randomUUID(),
      payload: { ...f.envelope.payload, toolName: 'other.local.tool' },
    }
  const adapter = pg.createPostgresCommandJournal({
    transactions: f.transactions,
    token: f.alice.token,
    editorId: f.editorId,
    editorGeneration: 3,
  })
  const service = createCommandService({
    journal: adapter,
    lookupTool: () => ({ ...tool, name: 'other.local.tool' }),
  })
  await service.proposeCommand(other)
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query(
          'UPDATE command_journal SET record=record||\'{"state":"abandoned_uncommitted"}\'::jsonb WHERE command_id=$1',
          [other.commandId],
        ),
      ),
    { code: '23514' },
  )
  const input = await bind(f),
    saved = await f.revisions.commitRevision(f.alice.token, input)
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query(
          'UPDATE command_journal SET record=(record-\'revision\')||\'{"state":"abandoned_uncommitted"}\'::jsonb WHERE command_id=$1',
          [f.envelope.commandId],
        ),
      ),
    { code: '23514' },
  )
  assert.deepEqual((await f.make(4).service.getCommandOutcome(f.envelope)).revision, saved)
})
