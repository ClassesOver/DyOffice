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
const owned = (f, fn, token = f.alice.token) =>
  f.transactions.withPrincipalTransaction({ kind: 'session', token }, fn)
async function fixture(t) {
  assert.equal(typeof pg.createPostgresCommandJournal, 'function')
  const f = await fileFixture(t),
    bytes = await docxBytes(),
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
    payload: { toolName: 'replace_text', arguments: { text: 'hello' } },
  }
  const make = (generation = 3, token = f.alice.token) => {
    const adapter = pg.createPostgresCommandJournal({
      transactions: f.transactions,
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

test('real PostgreSQL atomically admits one command claim and keeps unknown across adapter recreation', async (t) => {
  const f = await fixture(t),
    digest = await approve(f)
  const result = await Promise.allSettled([
    f.make().service.beginExecution(f.envelope, digest),
    f.make().service.beginExecution(f.envelope, digest),
  ])
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal((await f.make().service.getCommandOutcome(f.envelope)).state, 'unknown_outcome')
  assert.equal(
    await f
      .make(3, f.bob.token)
      .service.getCommandOutcome(f.envelope)
      .catch((e) => e.statusCode),
    404,
  )
})

test('lease epoch changed while the claim waits for database lock rejects stale apply', async (t) => {
  const f = await fixture(t),
    digest = await approve(f)
  let ready, release
  const entered = new Promise((r) => (ready = r)),
    gate = new Promise((r) => (release = r))
  const hold = owned(f, async (c) => {
    await c.query(
      'SELECT 1 FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE',
      [f.deploymentId, f.alice.user.id],
    )
    ready()
    await gate
    await c.query('UPDATE edit_leases SET lease_epoch=lease_epoch+1 WHERE file_id=$1', [
      f.initial.fileId,
    ])
  })
  await entered
  const claiming = f.make().service.beginExecution(f.envelope, digest)
  claiming.catch(() => {})
  await waitForDatabaseLock(f, 'business')
  release()
  await hold
  await assert.rejects(claiming, { statusCode: 409 })
  assert.equal((await f.make().service.getCommandOutcome(f.envelope)).state, 'approved')
})

test('T06 receipt is accepted only for the exact bound upload command owner session and byte digest', async (t) => {
  const f = await fixture(t),
    digest = await apply(f),
    input = await draft(f)
  const binding = {
    commandId: f.envelope.commandId,
    fileId: f.envelope.fileId,
    digest,
    uploadId: input.uploadId,
    sha256: f.initial.sha256,
    size: f.bytes.length,
    idempotencyKey: input.idempotencyKey,
  }
  await f.make(4).adapter.bindCommandUpload(binding)
  const saved = await f.revisions.commitRevision(f.alice.token, input)
  await assert.rejects(() =>
    f.make(4).service.recordCommitted(f.envelope, { ...saved, sha256: 'a'.repeat(64) }),
  )
  assert.equal((await f.make(4).service.recordCommitted(f.envelope, saved)).state, 'committed')
  assert.equal((await f.make(4).service.cancelCommand(f.envelope)).state, 'committed')
})

test('a sourceCommandId without a prior upload binding is not proof of command effect', async (t) => {
  const f = await fixture(t)
  await apply(f)
  const input = await draft(f)
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token, input), { statusCode: 409 })
  assert.equal(
    (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
    f.initial.revision,
  )
  await assert.rejects(() =>
    f.make(4).service.recordCommitted(f.envelope, { ...f.initial, revision: randomUUID() }),
  )
  assert.equal((await f.make(4).service.getCommandOutcome(f.envelope)).state, 'applied_uncommitted')
})

const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
test('session revoked by an earlier real auth transaction rejects a waiting command claim', async (t) => {
  const f = await fixture(t),
    digest = await approve(f),
    ready = deferred(),
    release = deferred()
  const { createSessionService } = await import('../../server/src/modules/auth/sessions.ts')
  const controlled = {
    ...f.db,
    transaction: (operation) =>
      f.db.transaction(async (c) => {
        const result = await operation(c)
        const s = (
          await c.query('SELECT revoked_at FROM sessions WHERE id=$1', [f.alice.sessionId])
        ).rows[0]
        if (s.revoked_at) {
          ready.resolve()
          await release.promise
        }
        return result
      }),
  }
  const sessions = createSessionService({
    db: controlled,
    accounts: f.accounts,
    deploymentId: f.deploymentId,
  })
  const revoking = sessions.revoke(f.alice.token, f.alice.sessionId)
  let claiming
  try {
    await ready.promise
    claiming = f.make().service.beginExecution(f.envelope, digest)
    claiming.catch(() => {})
    await waitForDatabaseLock(f, 'business')
    release.resolve()
    await revoking
    await assert.rejects(claiming, { statusCode: 401 })
  } finally {
    release.resolve()
    await Promise.allSettled([revoking, claiming].filter(Boolean))
  }
})

test('real PostgreSQL row locks fence a stale undo after lease takeover', async (t) => {
  const f = await fixture(t)
  await apply(f)
  const ready = deferred(),
    release = deferred(),
    held = owned(f, async (c) => {
      await c.query(
        'SELECT 1 FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE',
        [f.deploymentId, f.alice.user.id],
      )
      ready.resolve()
      await release.promise
      await c.query('UPDATE edit_leases SET lease_epoch=lease_epoch+1 WHERE file_id=$1', [
        f.initial.fileId,
      ])
    })
  let undo
  try {
    await ready.promise
    undo = f.make(4).service.beginUndo(f.envelope)
    undo.catch(() => {})
    await waitForDatabaseLock(f, 'business')
    release.resolve()
    await held
    await assert.rejects(undo, { statusCode: 409 })
    assert.equal(
      (await f.make(4).service.getCommandOutcome(f.envelope)).state,
      'applied_uncommitted',
    )
  } finally {
    release.resolve()
    await Promise.allSettled([held, undo].filter(Boolean))
  }
})

test('journal RLS and SQL transition guards deny cross-session access and identity rewrites', async (t) => {
  const f = await fixture(t),
    digest = await approve(f)
  assert.equal(
    (await owned(f, (c) => c.query('SELECT * FROM command_journal'), f.bob.token)).rowCount,
    0,
  )
  const { password } = await import('../helpers/identity.mjs'),
    other = await f.sessions.login('alice', password)
  assert.equal(
    (await owned(f, (c) => c.query('SELECT * FROM command_journal'), other.token)).rowCount,
    0,
  )
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query(
          "UPDATE command_journal SET record=jsonb_set(record,'{envelope,payload,arguments,text}','\"tampered\"')",
        ),
      ),
    { code: '23514' },
  )
  const claim = await f.make().service.beginExecution(f.envelope, digest)
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query("UPDATE command_journal SET record=jsonb_set(record,'{state}','\"approved\"')"),
      ),
    { code: '23514' },
  )
  assert.equal((await f.make().service.getCommandOutcome(f.envelope)).claimId, claim.claimId)
  await assert.rejects(() => f.authPool.query('SELECT * FROM command_journal'), { code: '42501' })
  await assert.rejects(() => owned(f, (c) => c.query('DELETE FROM command_journal')), {
    code: '42501',
  })
})

test('process exit after committed claim leaves unknown in real PostgreSQL and never replays', async (t) => {
  const f = await fixture(t),
    digest = await approve(f)
  const code = `
 import {Pool} from 'pg';
 import {createPrincipalTransactions} from './server/src/db/context.ts';
 import {createPostgresCommandJournal} from './server/src/modules/commands/postgres-journal.ts';
 import {createCommandService} from './server/src/modules/commands/service.ts';
 const pool=new Pool({connectionString:process.env.COMMAND_TEST_DB});
 const transactions=createPrincipalTransactions({pool,deploymentId:process.env.COMMAND_TEST_DEPLOYMENT});
 const journal=createPostgresCommandJournal({transactions,token:process.env.COMMAND_TEST_TOKEN,editorId:process.env.COMMAND_TEST_EDITOR,editorGeneration:3});
 const tool=JSON.parse(process.env.COMMAND_TEST_TOOL),envelope=JSON.parse(process.env.COMMAND_TEST_ENVELOPE);
 await createCommandService({journal,lookupTool:()=>tool}).beginExecution(envelope,process.env.COMMAND_TEST_DIGEST);
 process.exit(77);
 `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      COMMAND_TEST_DB: f.urls.business,
      COMMAND_TEST_DEPLOYMENT: f.deploymentId,
      COMMAND_TEST_TOKEN: f.alice.token,
      COMMAND_TEST_EDITOR: f.editorId,
      COMMAND_TEST_TOOL: JSON.stringify(tool),
      COMMAND_TEST_ENVELOPE: JSON.stringify(f.envelope),
      COMMAND_TEST_DIGEST: digest,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr.on('data', (b) => (errors += b))
  const exit = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(exit, 77, errors)
  assert.equal((await f.make().service.getCommandOutcome(f.envelope)).state, 'unknown_outcome')
  await assert.rejects(() => f.make().service.beginExecution(f.envelope, digest))
})

test('permanent purge preserves command tombstones but prevents further command operations', async (t) => {
  const f = await fixture(t)
  await approve(f)
  await f.files.trashFile(f.alice.token, f.initial.fileId)
  await f.files.purgeFile(f.alice.token, f.initial.fileId)
  await assert.rejects(() => f.make().service.getCommandOutcome(f.envelope), { statusCode: 404 })
  assert.equal(
    (await owned(f, (c) => c.query('SELECT state FROM command_journal'))).rows[0].state,
    'approved',
  )
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query("UPDATE command_journal SET record=jsonb_set(record,'{state}','\"cancelled\"')"),
      ),
    { code: '23514' },
  )
})

test('database rejects incomplete command identity even from an otherwise authorized SQL session', async (t) => {
  const f = await fixture(t)
  const valid = await f.make().service.proposeCommand(f.envelope)
  for (const mutate of [
    (r) => delete r.digest,
    (r) => (r.digest = null),
    (r) => delete r.policyHash,
    (r) => (r.policyHash = null),
    (r) => delete r.envelope,
    (r) => (r.envelope = null),
    (r) => (r.envelope.argsHash = null),
  ]) {
    const id = randomUUID(),
      record = structuredClone(valid)
    record.envelope.commandId = id
    mutate(record)
    await assert.rejects(
      () =>
        owned(f, (c) =>
          c.query(
            'INSERT INTO command_journal(deployment_id,owner_id,session_id,command_id,file_id,record) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
            [
              f.deploymentId,
              f.alice.user.id,
              f.alice.sessionId,
              id,
              f.initial.fileId,
              JSON.stringify(record),
            ],
          ),
        ),
      { code: '23514' },
    )
  }
})

async function bind(f) {
  const digest = await apply(f),
    input = await draft(f)
  await f
    .make(4)
    .adapter.bindCommandUpload({
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
test('T06 commit and undo are mutually exclusive without a separate receipt-report window', async (t) => {
  const f = await fixture(t),
    input = await bind(f)
  const undo = await f.make(4).service.beginUndo(f.envelope)
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token, input))
  await f.make(5).service.reportUndone(f.envelope, undo.claimId)
  assert.equal(
    (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
    f.initial.revision,
  )
})
test('successful T06 commit atomically marks the command committed before any client report', async (t) => {
  const f = await fixture(t),
    input = await bind(f),
    saved = await f.revisions.commitRevision(f.alice.token, input)
  const row = await f.make(4).service.getCommandOutcome(f.envelope)
  assert.equal(row.state, 'committed')
  assert.deepEqual(row.revision, saved)
  await assert.rejects(() => f.make(4).service.beginUndo(f.envelope))
})

test('SQL guards reject missing null invalid claim IDs and cannot rebind a reported claim', async (t) => {
  const f = await fixture(t),
    digest = await approve(f)
  for (const claimId of [undefined, null, 'invalid']) {
    const fields = {
      state: 'unknown_outcome',
      operation: 'apply',
      ...(claimId === undefined ? {} : { claimId }),
    }
    await assert.rejects(
      () =>
        owned(f, (c) =>
          c.query('UPDATE command_journal SET record=record||$1::jsonb', [JSON.stringify(fields)]),
        ),
      { code: '23514' },
    )
  }
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query('UPDATE command_journal SET record=record||\'{"approvedUntil":null}\'::jsonb'),
      ),
    { code: '23514' },
  )
  const claim = await f.make().service.beginExecution(f.envelope, digest)
  await assert.rejects(
    () =>
      owned(f, (c) =>
        c.query('UPDATE command_journal SET record=record||$1::jsonb', [
          JSON.stringify({
            state: 'applied_uncommitted',
            appliedGeneration: 4,
            claimId: randomUUID(),
          }),
        ]),
      ),
    { code: '23514' },
  )
  assert.equal((await f.make().service.getCommandOutcome(f.envelope)).claimId, claim.claimId)
})

test('concurrent durable save and undo admit one winner under real PostgreSQL locks', async (t) => {
  const f = await fixture(t),
    input = await bind(f)
  const results = await Promise.allSettled([
    f.revisions.commitRevision(f.alice.token, input),
    f.make(4).service.beginUndo(f.envelope),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.find((r) => r.status === 'rejected').reason.statusCode, 409)
  const row = await f.make(4).service.getCommandOutcome(f.envelope)
  assert.ok(['committed', 'unknown_outcome'].includes(row.state))
  if (row.state === 'unknown_outcome') assert.equal(row.operation, 'undo')
})

test('process exit before T06 commit rolls back file and command receipt together', async (t) => {
  const f = await fixture(t),
    input = await bind(f)
  const code = `
 import {Pool} from 'pg';
 import {createPrincipalTransactions} from './server/src/db/context.ts';
 import {createRevisionService} from './server/src/modules/revisions/service.ts';
 import {createLocalObjectStore} from './server/src/storage/local-dev.ts';
 const pool=new Pool({connectionString:process.env.COMMAND_TEST_DB});
 const base=createPrincipalTransactions({pool,deploymentId:process.env.COMMAND_TEST_DEPLOYMENT});
 const transactions={withPrincipalTransaction:(credential,fn)=>base.withPrincipalTransaction(credential,async(c,p)=>{await fn(c,p);process.exit(81)})};
 const objects=await createLocalObjectStore({directory:process.env.COMMAND_TEST_DIRECTORY});
 await createRevisionService({transactions,objects,files:{}}).commitRevision(process.env.COMMAND_TEST_TOKEN,JSON.parse(process.env.COMMAND_TEST_INPUT));
 `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      COMMAND_TEST_DB: f.urls.business,
      COMMAND_TEST_DEPLOYMENT: f.deploymentId,
      COMMAND_TEST_TOKEN: f.alice.token,
      COMMAND_TEST_DIRECTORY: f.directory,
      COMMAND_TEST_INPUT: JSON.stringify(input),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr.on('data', (b) => (errors += b))
  const exit = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(exit, 81, errors)
  assert.equal((await f.make(4).service.getCommandOutcome(f.envelope)).state, 'applied_uncommitted')
  assert.equal(
    (await f.files.openFile(f.alice.token, f.initial.fileId)).file.revision,
    f.initial.revision,
  )
  const saved = await f.revisions.commitRevision(f.alice.token, input)
  assert.deepEqual((await f.make(4).service.getCommandOutcome(f.envelope)).revision, saved)
})

test('a bound upload cannot omit or replace sourceCommandId to bypass atomic journal commit', async (t) => {
  const f = await fixture(t),
    input = await bind(f)
  for (const sourceCommandId of [undefined, randomUUID()]) {
    const wrong = { ...input, sourceCommandId }
    if (sourceCommandId === undefined) delete wrong.sourceCommandId
    await assert.rejects(() => f.revisions.commitRevision(f.alice.token, wrong), {
      statusCode: 409,
    })
  }
  const saved = await f.revisions.commitRevision(f.alice.token, input)
  assert.deepEqual((await f.make(4).service.getCommandOutcome(f.envelope)).revision, saved)
})
