import {assertDisposableSourceDatabase} from '../helpers/disposable-source-database.mjs'
// Real disposable PG tests for bounded, JSONB-materialized personal workspace results.
// Never invokes a source connector while saving, paging, or downloading a result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { restrictedFixture } from '../helpers/restricted.mjs'
import { password } from '../helpers/identity.mjs'
import { createSourceService } from '../../server/src/modules/sources/service.ts'
import { createQuerySnapshot } from '../../server/src/modules/sources/provenance.ts'
import { createWorkspaceSourceResults } from '../../server/src/modules/sources/results.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
const queryHash = digest('SELECT bounded fixture')
const status = expected => error => error.statusCode === expected
const canonical = snapshot => JSON.stringify(snapshot)
const pendingTtlMs = 15 * 60_000

function snapshot({ sourceId = 'metrics', sourceVersion = 1, count = 1203, text = '=SUM(A1:A2)', truncated = true } = {}) {
  return createQuerySnapshot({ sourceId, sourceVersion, timezone: 'Asia/Shanghai',
    schema: [{ name: 'zz_amount', type: 'number', unit: 'CNY' }, { name: 'a_time', type: 'string', unit: 'ISO8601' }, { name: 'flag', type: 'boolean' }, { name: 'literal', type: 'string' }],
    rows: Array.from({ length: count }, (_, i) => ({ literal: text, flag: i % 2 === 0, a_time: '2026-11-17T01:02:03.000Z', zz_amount: i + 0.5 })), sourceTruncated: truncated,
  })
}

async function fixture(t, limits = {}) {
  assertDisposableSourceDatabase(process.env.DYOFFICE_TEST_DATABASE_URL)
  const f = await restrictedFixture(t, { businessMax: 8, sourcesCredentialKeys: 'k1:' + randomBytes(32).toString('base64') })
  f.sources = createSourceService({ transactions: f.transactions, credentialKeys: 'k2:' + randomBytes(32).toString('base64') })
  f.results = createWorkspaceSourceResults({ transactions: f.transactions, ...limits })
  f.anotherLogin = () => f.sessions.login('alice', password)
  f.scoped = async (sql, values = [], ownerId = f.alice.user.id) => {
    const c = await f.ownerPool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)", [f.deploymentId, ownerId])
      const result = await c.query(sql, values)
      await c.query('COMMIT')
      return result
    } catch (error) { await c.query('ROLLBACK'); throw error } finally { c.release() }
  }
  f.createSource = async (token = f.alice.token, sourceId = 'metrics') => {
    await f.sources.create(token, { sourceId, name: 'Metrics', kind: 'http', config: { timezone: 'Asia/Shanghai' }, secret: 'https://results.example.invalid/data' })
  }
  await f.createSource()
  return f
}

async function rowCounts(f) {
  return (await f.scoped('SELECT state,count(*)::integer AS count,COALESCE(sum(size_bytes),0)::integer AS bytes FROM workspace_source_results GROUP BY state ORDER BY state')).rows
}

test('pending capture/read is owner/workspace/source/session scoped, defaults to 1000 rows, and FORCE RLS hides foreign data', async t => {
  const f = await fixture(t), s = snapshot()
  const start = Date.now(), captured = await f.results.capture(f.alice.token, s, queryHash)
  assert.match(captured.resultId, /^[a-f0-9-]{36}$/)
  assert.equal(captured.state, 'pending'); assert.equal(captured.name, null)
  assert.equal(captured.sourceId, 'metrics'); assert.equal(captured.sourceVersion, 1)
  assert.equal(captured.rowCount, 1203); assert.equal(captured.truncated, true)
  assert.equal(captured.sha256, s.sha256); assert.equal(captured.queryHash, queryHash)
  assert.equal(captured.sizeBytes, Buffer.byteLength(canonical(s)))
  assert.ok(Date.parse(captured.expiresAt) >= start + pendingTtlMs - 100)
  assert.ok(Date.parse(captured.expiresAt) <= Date.now() + pendingTtlMs + 100)
  const workspace = (await f.scoped('SELECT id FROM workspaces')).rows[0]
  assert.equal(captured.workspaceId, workspace.id)
  const page = await f.results.read(f.alice.token, { resultId: captured.resultId })
  assert.equal(page.rows.length, 1000); assert.equal(page.nextOffset, 1000)
  assert.equal(page.totalRows, 1203); assert.equal(page.sourceTruncated, true)
  assert.equal(page.timezone, s.timezone); assert.equal(page.sha256, s.sha256)
  assert.deepEqual(page.rows, s.rows.slice(0, 1000)); assert.deepEqual(page.schema, s.schema)
  assert.deepEqual(await f.results.list(f.alice.token), { items: [], nextCursor: null })
  const otherSession = await f.anotherLogin()
  for (const token of [f.bob.token, f.adminSigned.token, otherSession.token]) {
    await assert.rejects(f.results.read(token, { resultId: captured.resultId }), status(404))
    await assert.rejects(f.results.save(token, { resultId: captured.resultId, name: 'Private', commandId: randomUUID() }), status(404))
    await assert.rejects(f.results.download(token, captured.resultId), status(404))
  }
  await assert.rejects(f.results.capture(f.bob.token, s, queryHash), status(404))
  await assert.rejects(f.results.capture(f.adminSigned.token, s, queryHash), status(404))
  await f.createSource(f.bob.token)
  const bob = await f.results.capture(f.bob.token, snapshot({ count: 1 }), queryHash)
  assert.notEqual(bob.workspaceId, captured.workspaceId)
  const rawBob = await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.bob.token }, c => c.query('SELECT result_id FROM workspace_source_results WHERE result_id=$1', [captured.resultId]))
  assert.equal(rawBob.rowCount, 0)
  const flags = (await f.ownerPool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='workspace_source_results'::regclass")).rows[0]
  assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true })
  await assert.rejects(f.results.read(f.alice.token, { resultId: captured.resultId, ownerId: f.bob.user.id }), status(400))
  await assert.rejects(f.results.read(f.alice.token, { resultId: captured.resultId, limit: 1001 }), status(400))
  await assert.rejects(f.results.read(f.alice.token, { resultId: captured.resultId, offset: -1 }), status(400))
})

test('expired or disabled pending results reject read/save; capture verifies current source and provenance counter', async t => {
  const f = await fixture(t)
  const expired = await f.results.capture(f.alice.token, snapshot({ count: 1 }), queryHash)
  await f.scoped("UPDATE workspace_source_results SET expires_at=clock_timestamp()-interval '1 second' WHERE result_id=$1", [expired.resultId])
  for (const action of [() => f.results.read(f.alice.token, { resultId: expired.resultId }), () => f.results.download(f.alice.token, expired.resultId), () => f.results.save(f.alice.token, { resultId: expired.resultId, name: 'Expired', commandId: randomUUID() })]) await assert.rejects(action(), status(404))
  const active = await f.results.capture(f.alice.token, snapshot({ count: 2 }), queryHash)
  assert.equal((await f.scoped('SELECT count(*)::integer AS count FROM workspace_source_results WHERE result_id=$1', [expired.resultId])).rows[0].count, 0)
  await f.sources.save(f.alice.token, 'metrics', { expectedVersion: 1, enabled: false })
  for (const action of [() => f.results.read(f.alice.token, { resultId: active.resultId }), () => f.results.save(f.alice.token, { resultId: active.resultId, name: 'Disabled', commandId: randomUUID() }), () => f.results.capture(f.alice.token, snapshot({ count: 1 }), queryHash)]) await assert.rejects(action(), status(409))
  await f.sources.save(f.alice.token, 'metrics', { expectedVersion: 2, enabled: true })
  await assert.rejects(f.results.read(f.alice.token, { resultId: active.resultId }), status(409))
  await assert.rejects(f.results.capture(f.alice.token, snapshot({ count: 1 }), queryHash), status(409))
  const current = await f.results.capture(f.alice.token, snapshot({sourceVersion:3,count:1}), queryHash)
  assert.equal(current.sourceVersion,3)

  await assert.rejects(f.results.capture(f.alice.token, snapshot({ sourceVersion: 99, count: 1 }), queryHash), status(404))
  await assert.rejects(f.results.capture(f.alice.token, snapshot({ sourceId: 'missing', count: 1 }), queryHash), status(404))
  await f.sources.create(f.alice.token, { sourceId: 'draft-only', name: 'Draft', kind: 'http', config: {}, secret: 'https://results.example.invalid/data' })
  assert.equal((await f.results.capture(f.alice.token, snapshot({ sourceId: 'draft-only', count: 1 }), queryHash)).sourceId, 'draft-only')
})

test('save is durable across owner sessions, idempotent with frozen receipt and bounded quota, and retains data after source tombstone', async t => {
  const s = snapshot({ count: 3 }), bytes = Buffer.byteLength(canonical(s))
  const f = await fixture(t, { maxSavedResults: 1, maxSavedBytes: bytes })
  const pending = await f.results.capture(f.alice.token, s, queryHash)
  const command = { resultId: pending.resultId, name: '个人结果.json', commandId: randomUUID() }
  const saved = await f.results.save(f.alice.token, command)
  assert.equal(saved.resultId, pending.resultId); assert.equal(saved.state, 'saved')
  assert.equal(saved.name, command.name); assert.equal(saved.expiresAt, null); assert.ok(saved.savedAt)
  assert.deepEqual(await f.results.save(f.alice.token, command), saved)
  const login = await f.anotherLogin()
  assert.deepEqual(await f.results.save(login.token, command), saved)
  await assert.rejects(f.results.save(f.alice.token, { ...command, name: 'Changed' }), status(409))
  await assert.rejects(f.results.save(f.alice.token, { ...command, commandId: randomUUID() }), status(409))
  assert.deepEqual(await rowCounts(f), [{ state: 'saved', count: 1, bytes }])
  const other = await f.results.capture(f.alice.token, s, queryHash)
  await assert.rejects(f.results.save(f.alice.token, { ...command, resultId: other.resultId }), status(409))
  await assert.rejects(f.results.save(f.alice.token, { resultId: other.resultId, name: 'Over quota', commandId: randomUUID() }), status(413))
  await f.sources.remove(f.alice.token, 'metrics', { expectedVersion: 1 })
  const page = await f.results.read(login.token, { resultId: saved.resultId })
  assert.deepEqual(page.rows, s.rows); assert.equal(page.artifact.state, 'saved')
  const download = await f.results.download(login.token, saved.resultId)
  assert.equal(download.name, command.name); assert.equal(download.bytes.toString('utf8'), canonical(s)); assert.equal(download.sha256, s.sha256)
  const listed = await f.results.list(login.token)
  assert.deepEqual(listed.items, [saved]); assert.equal(listed.nextCursor, null)
  assert.equal((await f.results.list(f.bob.token)).items.length, 0)
  await assert.rejects(f.results.read(f.bob.token, { resultId: saved.resultId }), status(404))
  await assert.rejects(f.results.read(f.adminSigned.token, { resultId: saved.resultId }), status(404))
  await assert.rejects(f.results.save(f.bob.token, command), status(404))
  await assert.rejects(f.results.download(f.adminSigned.token, saved.resultId), status(404))
  await assert.rejects(f.results.read(f.alice.token, { resultId: other.resultId }), status(404))
  // Data JSONB has an independent logical quota, never T05 object physical bytes.
  assert.equal((await f.scoped('SELECT COALESCE(sum(stored_bytes),0)::integer AS bytes FROM storage_accounts')).rows[0].bytes, 0)
})

test('parallel capture and save serialize workspace count/byte quotas, duplicate command makes one artifact', async t => {
  const s = snapshot({ count: 1 }), bytes = Buffer.byteLength(canonical(s))
  const f = await fixture(t, { maxPendingResults: 3, maxPendingBytes: bytes * 3, maxSavedResults: 2, maxSavedBytes: bytes * 2 })
  const logins = [f.alice, await f.anotherLogin(), await f.anotherLogin(), await f.anotherLogin(), await f.anotherLogin()]
  const captures = await Promise.allSettled(logins.map(login => f.results.capture(login.token, s, queryHash)))
  const accepted = captures.flatMap((r, i) => r.status === 'fulfilled' ? [{ ...r.value, token: logins[i].token }] : [])
  assert.equal(accepted.length, 3)
  for (const failed of captures.filter(r => r.status === 'rejected')) assert.equal(failed.reason.statusCode, 413)
  const saves = await Promise.allSettled(accepted.map(result => f.results.save(result.token, { resultId: result.resultId, name: result.resultId, commandId: randomUUID() })))
  assert.equal(saves.filter(r => r.status === 'fulfilled').length, 2)
  assert.equal(saves.find(r => r.status === 'rejected').reason.statusCode, 413)
  assert.deepEqual(await rowCounts(f), [{ state: 'pending', count: 1, bytes }, { state: 'saved', count: 2, bytes: bytes * 2 }])
  const fresh = await fixture(t, { maxSavedResults: 1, maxSavedBytes: bytes })
  const pending = await fresh.results.capture(fresh.alice.token, s, queryHash)
  const command = { resultId: pending.resultId, name: 'Once', commandId: randomUUID() }
  const duplicate = await Promise.all(Array.from({ length: 6 }, () => fresh.results.save(fresh.alice.token, command)))
  assert.ok(duplicate.every(receipt => JSON.stringify(receipt) === JSON.stringify(duplicate[0])))
  assert.deepEqual(await rowCounts(fresh), [{ state: 'saved', count: 1, bytes }])
})

test('byte budgets reject independently of counts and expired reclamation deletes at most 16 pending rows, never saved', async t => {
  const s = snapshot({ count: 1 }), bytes = Buffer.byteLength(canonical(s))
  const f = await fixture(t, { maxPendingBytes: bytes, maxSavedBytes: bytes })
  const first = await f.results.capture(f.alice.token, s, queryHash)
  await assert.rejects(f.results.capture(f.alice.token, s, queryHash), status(413))
  const saved = await f.results.save(f.alice.token, { resultId: first.resultId, name: 'Keep', commandId: randomUUID() })
  const next = await f.results.capture(f.alice.token, s, queryHash)
  await assert.rejects(f.results.save(f.alice.token, { resultId: next.resultId, name: 'Too many bytes', commandId: randomUUID() }), status(413))
  // Seed stale rows as migration owner solely to observe the bounded reclaimer.
  await f.scoped(`INSERT INTO workspace_source_results(result_id,deployment_id,owner_id,workspace_id,source_id,source_version,query_hash,sha256,row_count,truncated,size_bytes,snapshot,state,session_id,expires_at)
    SELECT gen_random_uuid(),deployment_id,owner_id,workspace_id,source_id,source_version,query_hash,sha256,row_count,truncated,size_bytes,snapshot,'pending',session_id,clock_timestamp()-interval '1 second'
    FROM workspace_source_results CROSS JOIN generate_series(1,20) WHERE result_id=$1`, [next.resultId])
  const cleanup = createWorkspaceSourceResults({ transactions: f.transactions })
  await cleanup.capture(f.alice.token, s, queryHash)
  assert.equal((await f.scoped("SELECT count(*)::integer AS count FROM workspace_source_results WHERE state='pending' AND expires_at<=clock_timestamp()")).rows[0].count, 4)
  assert.equal((await cleanup.read(f.alice.token, { resultId: saved.resultId })).artifact.state, 'saved')
})

test('canonical reconstruction preserves schema order, units, timezone, literal strings and hash; pages never replay the source', async t => {
  const f = await fixture(t), s = snapshot({ count: 2301 })
  const captured = await f.results.capture(f.alice.token, JSON.parse(canonical(s)), queryHash)
  const saved = await f.results.save(f.alice.token, { resultId: captured.resultId, name: '=literal', commandId: randomUUID() })
  // No connector was configured/approved: these rows only ever come from JSONB.
  await f.sources.save(f.alice.token, 'metrics', { expectedVersion: 1, enabled: false })
  const rows = []
  let offset = 0
  do {
    const page = await f.results.read(f.alice.token, { resultId: saved.resultId, offset })
    assert.equal(page.sha256, s.sha256); assert.deepEqual(page.schema, s.schema)
    rows.push(...page.rows); offset = page.nextOffset
  } while (offset !== null)
  assert.deepEqual(rows, s.rows)
  const end = await f.results.read(f.alice.token, { resultId: saved.resultId, offset: 2301 })
  assert.deepEqual(end.rows, []); assert.equal(end.nextOffset, null)
  const download = await f.results.download(f.alice.token, saved.resultId)
  assert.equal(download.name, '=literal.json'); assert.equal(download.bytes.toString(), canonical(s))
  const { sha256, ...evidence } = JSON.parse(download.bytes.toString())
  assert.equal(digest(JSON.stringify(evidence)), sha256)
  assert.equal(JSON.parse(download.bytes.toString()).rows[0].literal, '=SUM(A1:A2)')
  assert.equal((await f.scoped("SELECT count(*)::integer AS count FROM data_source_audit WHERE action='source_queried'")).rows[0].count, 0)
  const ids = []
  for (let i = 0; i < 2; i++) {
    // Already saved data remains listable after source disabled; make more with
    // another enabled source to prove native keyset paging.
    if (i === 0) await f.createSource(f.alice.token, 'paging')
    const result = await f.results.capture(f.alice.token, snapshot({ sourceId: 'paging', count: 1 }), queryHash)
    ids.push((await f.results.save(f.alice.token, { resultId: result.resultId, name: 'Page ' + i, commandId: randomUUID() })).resultId)
  }
  ids.push(saved.resultId)
  const seen = []
  let after
  do { const page = await f.results.list(f.alice.token, { limit: 1, ...(after ? { after } : {}) }); seen.push(...page.items.map(item => item.resultId)); after = page.nextCursor } while (after)
  assert.deepEqual(seen, ids.sort())
})

test('capture rejects forged snapshots, oversized snapshots, raw query text and unsafe filenames; download re-verifies JSONB', async t => {
  const f = await fixture(t), s = snapshot({ count: 1 })
  await assert.rejects(f.results.capture(f.alice.token, { ...s, sha256: '0'.repeat(64) }, queryHash), status(400))
  await assert.rejects(f.results.capture(f.alice.token, { ...s, version: 2 }, queryHash), status(400))
  await assert.rejects(f.results.capture(f.alice.token, { ...s, rows: [{ ...s.rows[0], zz_amount: 'wrong type' }] }, queryHash), status(400))
  await assert.rejects(f.results.capture(f.alice.token, { ...s, secret: 'dsn' }, queryHash), status(400))
  await assert.rejects(f.results.capture(f.alice.token, s, 'SELECT * FROM private_table'), status(400))
  await assert.rejects(f.results.capture(f.alice.token, snapshot({ count: 1, text: 'x'.repeat(4_000_000) }), queryHash), status(413))
  assert.deepEqual(await rowCounts(f), [])
  const captured = await f.results.capture(f.alice.token, s, queryHash)
  for (const name of ['../escape', '/tmp/x', 'a\\b', '..', 'line\nbreak', 'NUL', 'bad:name', 'x'.repeat(256)]) await assert.rejects(f.results.save(f.alice.token, { resultId: captured.resultId, name, commandId: randomUUID() }), status(400))
  const saved = await f.results.save(f.alice.token, { resultId: captured.resultId, name: 'Integrity', commandId: randomUUID() })
  await f.scoped(`UPDATE workspace_source_results SET snapshot=jsonb_set(snapshot,'{sha256}',to_jsonb(repeat('0',64))) WHERE result_id=$1`, [saved.resultId])
  await assert.rejects(f.results.download(f.alice.token, saved.resultId), status(500))
  await f.scoped('UPDATE workspace_source_results SET snapshot=$2::jsonb,sha256=$3 WHERE result_id=$1', [saved.resultId, canonical(s), '0'.repeat(64)])
  await assert.rejects(f.results.read(f.alice.token, { resultId: saved.resultId }), status(500))
})

test('limits are downward-configurable, capture detaches evidence, and runtime cannot rewrite its snapshot', async t => {
  const f = await fixture(t), s = snapshot({ count: 1 }), bytes = Buffer.byteLength(canonical(s))
  for (const options of [{ maxSavedBytes: 256 * 1024 * 1024 + 1 }, { maxSavedResults: 65 }, { maxPendingBytes: 32 * 1024 * 1024 + 1 }, { maxPendingResults: 9 }, { maxSnapshotBytes: 4_000_001 }, { pendingTtlMs: 900_001 }, { maxPendingResults: 0 }]) {
    assert.throws(() => createWorkspaceSourceResults({ transactions: f.transactions, ...options }), /Invalid workspace source result limit/)
  }
  const small = createWorkspaceSourceResults({ transactions: f.transactions, maxSnapshotBytes: bytes - 1 })
  await assert.rejects(small.capture(f.alice.token, s, queryHash), status(413))
  const exact = createWorkspaceSourceResults({ transactions: f.transactions, maxSnapshotBytes: bytes, pendingTtlMs: 60_000 })
  const mutable = JSON.parse(canonical(s)), started = Date.now()
  const capturing = exact.capture(f.alice.token, mutable, queryHash)
  mutable.rows[0].literal = 'changed after call'; mutable.schema[0].unit = 'wrong'
  const captured = await capturing
  assert.ok(Date.parse(captured.expiresAt) <= started + 60_100)
  assert.deepEqual((await exact.read(f.alice.token, { resultId: captured.resultId })).rows, s.rows)
  await assert.rejects(f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, c => c.query("UPDATE workspace_source_results SET snapshot='{}'::jsonb WHERE result_id=$1", [captured.resultId])), error => error.code === '42501')
  const commandId = randomUUID()
  await exact.save(f.alice.token, { resultId: captured.resultId, name: 'Alice', commandId })
  await f.createSource(f.bob.token)
  const bob = await exact.capture(f.bob.token, s, queryHash)
  const saved = await exact.save(f.bob.token, { resultId: bob.resultId, name: 'Bob', commandId })
  assert.equal(saved.name, 'Bob'); assert.notEqual(saved.workspaceId, captured.workspaceId)
  const fks = (await f.ownerPool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='workspace_source_results'::regclass AND contype='f'")).rows.map(row => row.def)
  assert.ok(fks.some(def => def.includes('REFERENCES users(deployment_id, id)')))
  assert.ok(fks.some(def => def.includes('REFERENCES workspaces(deployment_id, owner_id, id)')))
  assert.ok(fks.some(def => def.includes('REFERENCES data_sources(deployment_id, owner_id, source_id)')))
  assert.equal(fks.some(def => def.includes('REFERENCES data_source_versions')), false)
})

test('logout/revocation stops every read, save, list, download and capture even for saved materialized data', async t => {
  const f = await fixture(t), s = snapshot({ count: 1 })
  const pending = await f.results.capture(f.alice.token, s, queryHash)
  const saved = await f.results.save(f.alice.token, { resultId: pending.resultId, name: 'Saved', commandId: randomUUID() })
  const unsaved = await f.results.capture(f.alice.token, s, queryHash)
  await f.sessions.logout(f.alice.token)
  for (const action of [() => f.results.read(f.alice.token, { resultId: saved.resultId }), () => f.results.read(f.alice.token, { resultId: unsaved.resultId }), () => f.results.list(f.alice.token), () => f.results.download(f.alice.token, saved.resultId), () => f.results.capture(f.alice.token, s, queryHash), () => f.results.save(f.alice.token, { resultId: unsaved.resultId, name: 'After logout', commandId: randomUUID() })]) await assert.rejects(action(), status(401))
  const login = await f.anotherLogin()
  assert.equal((await f.results.read(login.token, { resultId: saved.resultId })).artifact.state, 'saved')
  await assert.rejects(f.results.read(login.token, { resultId: unsaved.resultId }), status(404))
})
