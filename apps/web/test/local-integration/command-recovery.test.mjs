import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
async function fixture(t) {
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

const reader = (f, token = f.alice.token, transactions = f.transactions) =>
  recovery.createPostgresCommandRecovery({ transactions, token })
const lookup = (f) => reader(f).lookup(f.initial.fileId, f.envelope.commandId)
test('fresh editor can recover exact historical committed receipt without granting old write authority', async (t) => {
  const f = await fixture(t),
    input = await bind(f),
    revision = await f.revisions.commitRevision(f.alice.token, input)
  const result = await lookup(f)
  assert.deepEqual(result, {
    commandId: f.envelope.commandId,
    fileId: f.initial.fileId,
    state: 'committed',
    digest: (await f.make(4).service.getCommandOutcome(f.envelope)).digest,
    revision,
  })
  const fresh = pg.createPostgresCommandJournal({
    transactions: f.transactions,
    token: f.alice.token,
    editorId: randomUUID(),
    editorGeneration: 4,
  })
  assert.equal(
    await fresh.withAuthorizedCommand(f.initial.fileId, f.envelope.commandId, async (tx, row) => ({
      value: await tx.verifyCommit(row, revision),
    })),
    false,
  )
  const staged = await f.revisions.stageUpload(f.alice.token, f.initial.fileId, {
    size: f.bytes.length,
    baseRevision: revision.revision,
    leaseEpoch: f.lease.leaseEpoch,
    editorId: f.editorId,
  })
  await f.files.receiveUpload(f.alice.token, staged.uploadId, f.bytes)
  const next = {
    fileId: f.initial.fileId,
    baseRevision: revision.revision,
    leaseEpoch: f.lease.leaseEpoch,
    idempotencyKey: randomUUID(),
    uploadId: staged.uploadId,
  }
  const head = await f.revisions.commitRevision(f.alice.token, next)
  assert.notEqual(head.revision, revision.revision)
  assert.deepEqual((await lookup(f)).revision, revision)
})
for (const state of ['pending', 'applied', 'abandoned'])
  test('minimal projection ' + state + ' has no args or capabilities', async (t) => {
    const f = await fixture(t)
    let digest
    if (state === 'pending') digest = (await f.make().service.proposeCommand(f.envelope)).digest
    else digest = await apply(f)
    if (state === 'abandoned') await f.make(4).service.abandonCommand(f.envelope, digest)
    const out = await lookup(f)
    assert.deepEqual(Object.keys(out).sort(), ['commandId', 'digest', 'fileId', 'state'])
    assert.equal(
      out.state,
      {
        pending: 'pending_approval',
        applied: 'applied_uncommitted',
        abandoned: 'abandoned_uncommitted',
      }[state],
    )
  })
test('unknown command, same-owner other session and cross-owner are indistinguishable 404', async (t) => {
  const f = await fixture(t)
  await approve(f)
  const other = await f.sessions.login('alice', (await import('../helpers/identity.mjs')).password)
  for (const token of [other.token, f.bob.token])
    await assert.rejects(reader(f, token).lookup(f.initial.fileId, f.envelope.commandId), {
      statusCode: 404,
    })
  await assert.rejects(reader(f).lookup(f.initial.fileId, randomUUID()), { statusCode: 404 })
})
for (const invalid of ['revoked', 'auth-version'])
  test('recovery rejects ' + invalid + ' session', async (t) => {
    const f = await fixture(t)
    await approve(f)
    if (invalid === 'revoked') await f.sessions.revoke(f.alice.token, f.alice.sessionId)
    else
      await f.ownerPool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [
        f.alice.user.id,
      ])
    await assert.rejects(lookup(f), { statusCode: 401 })
  })
async function ownerScope(f, fn) {
  const c = await f.ownerPool.connect()
  try {
    await c.query('BEGIN')
    await c.query(
      "SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true)",
      [f.deploymentId, f.alice.user.id, f.alice.sessionId],
    )
    const v = await fn(c)
    await c.query('COMMIT')
    return v
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    c.release()
  }
}
for (const corrupt of ['missing-binding', 'hash'])
  test('committed recovery fails closed on ' + corrupt, async (t) => {
    const f = await fixture(t),
      input = await bind(f)
    await f.revisions.commitRevision(f.alice.token, input)
    await ownerScope(f, (c) =>
      corrupt === 'missing-binding'
        ? c.query('DELETE FROM command_upload_bindings WHERE command_id=$1', [f.envelope.commandId])
        : c.query('UPDATE command_upload_bindings SET sha256=$2 WHERE command_id=$1', [
            f.envelope.commandId,
            'b'.repeat(64),
          ]),
    )
    await assert.rejects(lookup(f), { statusCode: 404 })
  })
test('recovery does not expire uploads, touch leases, or change journal/data timestamps', async (t) => {
  const f = await fixture(t)
  await approve(f)
  const input = await draft(f)
  await owned(f, (c) =>
    c.query(
      "UPDATE uploads SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [input.uploadId],
    ),
  )
  const snapshot = () =>
    ownerScope(f, async (c) => {
      const out = {}
      for (const table of [
        'sessions',
        'storage_accounts',
        'uploads',
        'files',
        'file_revisions',
        'edit_leases',
        'command_journal',
        'command_upload_bindings',
        'revision_commits',
      ])
        out[table] = (
          await c.query(
            "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM " +
              table +
              ' t',
          )
        ).rows[0].rows
      return out
    })
  const before = await snapshot()
  await lookup(f)
  assert.deepEqual(await snapshot(), before)
})
for (const final of ['commit', 'abandon'])
  test('lookup waiting on ' + final + ' observes final atomic state', async (t) => {
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
      final === 'commit'
        ? revisions.commitRevision(f.alice.token, input)
        : f.make(4, f.alice.token, held).service.abandonCommand(f.envelope, row.digest)
    first.catch(() => {})
    let pending
    try {
      await ready.promise
      pending = lookup(f)
      pending.catch(() => {})
      await waitForDatabaseLock(f, 'business')
      release.resolve()
      await first
      assert.equal(
        (await pending).state,
        final === 'commit' ? 'committed' : 'abandoned_uncommitted',
      )
    } finally {
      release.resolve()
      await Promise.allSettled([first, pending].filter(Boolean))
    }
  })
test('revocation committed ahead of waiting recovery denies authority', async (t) => {
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
    recovering = lookup(f)
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

for (const lifecycle of ['trash', 'purge'])
  test('recovery rejects file ' + lifecycle, async (t) => {
    const f = await fixture(t)
    await approve(f)
    await f.leases.releaseLease(f.alice.token, f.initial.fileId, {
      editorId: f.editorId,
      leaseEpoch: f.lease.leaseEpoch,
    })
    await f.files.trashFile(f.alice.token, f.initial.fileId)
    if (lifecycle === 'purge') await f.files.purgeFile(f.alice.token, f.initial.fileId)
    await assert.rejects(lookup(f), { statusCode: 404 })
  })
// Deliberate owner-level corruption, not a capability granted to the business role.
test('unknown persisted state is rejected even after owner bypasses SQL guards', async (t) => {
  const f = await fixture(t)
  await approve(f)
  await ownerScope(f, async (c) => {
    await c.query('ALTER TABLE command_journal DROP CONSTRAINT command_journal_state_check')
    await c.query('ALTER TABLE command_journal DISABLE TRIGGER command_journal_state')
    await c.query(
      "UPDATE command_journal SET record=jsonb_set(record,'{state}','\"future_state\"') WHERE command_id=$1",
      [f.envelope.commandId],
    )
  })
  await assert.rejects(lookup(f), { statusCode: 404 })
})
