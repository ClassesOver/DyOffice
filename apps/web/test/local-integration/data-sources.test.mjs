// T15 scoped HTTP/postgres data sources with provenance snapshots.
// Requires a disposable PostgreSQL admin connection via DYOFFICE_TEST_DATABASE_URL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { restrictedFixture, restrictedOrigin } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { buildLocalApp } from '../../server/src/app.ts'
import { Pool, Client } from 'pg'

async function fixture(t, options = {}) {
  const keys = options.sourcesCredentialKeys ?? credentialKeys()
  const f = await restrictedFixture(t, { ...options, sourcesCredentialKeys: keys })
  f.approve = async targets => {
    await f.app.close()
    f.app = await buildLocalApp({ db: f.db, businessPool: f.businessPool, deploymentId: f.deploymentId, origin: restrictedOrigin, csrfKey: f.csrfKey, passwords: f.passwords, sourcesCredentialKeys: keys, sourcesEgressTargets: targets })
    f.cleanup.push(() => f.app.close())
  }
  f.inspect = async (sql, values = [], ownerId = f.alice.user.id) => {
    const c = await f.ownerPool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)", [f.deploymentId, ownerId])
      const result = await c.query(sql, values)
      await c.query('ROLLBACK')
      return result
    } finally { c.release() }
  }
  return f
}
const httpApproval = url => ({ kind: 'http', endpoint: url, addresses: ['127.0.0.1'], allowInsecure: true })

const base = '/api/v1/sources'
const credentialKeys = () => 'k1:' + randomBytes(32).toString('base64')

function request(f, method, path, payload, token = f.alice.token) {
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  return f.app.inject({ method, url: base + path, payload, headers: { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token) } })
}
const call = async (f, method, path, payload, token, status) => {
  const response = await request(f, method, path, payload, token)
  assert.equal(response.statusCode, status, method + ' ' + path + ' -> ' + response.body)
  return response
}
const snapshotHash = snapshot => createHash('sha256')
  .update(JSON.stringify({ version: 1, sourceId: snapshot.sourceId, sourceVersion: snapshot.sourceVersion, schema: snapshot.schema, timezone: snapshot.timezone, rows: snapshot.rows, truncated: snapshot.truncated }))
  .digest('hex')

// A real postgres target database: a read-only role with access to one probe
// table, plus a role that lacks CONNECT entirely. Both are real PG denials.
async function postgresTargets(t, f) {
  const port = new URL(process.env.DYOFFICE_TEST_DATABASE_URL).port || '5432'
  const suffix = randomBytes(4).toString('hex')
  const quote = name => '"' + name + '"'
  const reader = 't15_reader_' + suffix, denied = 't15_denied_' + suffix
  const readerPw = randomBytes(16).toString('hex'), deniedPw = randomBytes(16).toString('hex')
  await f.admin.query(`CREATE ROLE ${quote(reader)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${readerPw}'`)
  await f.admin.query(`CREATE ROLE ${quote(denied)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${deniedPw}'`)
  await f.admin.query(`ALTER ROLE ${quote(reader)} SET default_transaction_read_only=on`)
  await f.admin.query(`GRANT CONNECT ON DATABASE ${quote(f.database)} TO ${quote(reader)}`)
  const targetUrl = new URL(process.env.DYOFFICE_TEST_DATABASE_URL); targetUrl.pathname = '/' + f.database
  const admin = new Pool({ connectionString: targetUrl.href })
  await admin.query(`REVOKE CONNECT ON DATABASE ${quote(f.database)} FROM PUBLIC`)
  await admin.query(`CREATE TABLE t15_probe_${suffix}(i integer, label text, ratio double precision, active boolean, note text)`)
  await admin.query(`INSERT INTO t15_probe_${suffix} VALUES (1,'alpha',1.5,true,NULL),(2,'beta',2.5,false,'x'),(3,'gamma',3.5,true,'y'),(4,'delta',4.5,false,NULL)`)
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${quote(reader)}`)
  await admin.query(`GRANT SELECT ON t15_probe_${suffix} TO ${quote(reader)}`)
  f.cleanup.unshift(async () => {
    await admin.query(`DROP TABLE t15_probe_${suffix}`)
    await admin.query(`REVOKE ALL ON DATABASE ${quote(f.database)} FROM ${quote(reader)}`)
    await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${quote(reader)}`)
    await admin.end()
    await f.admin.query(`DROP ROLE ${quote(reader)}`)
    await f.admin.query(`DROP ROLE ${quote(denied)}`)
  })
  const host = '127.0.0.1:' + port
  return {
    approvals: [reader, denied].map(username => ({ kind: 'postgres', endpoint: 'postgresql://' + host, username, database: f.database, addresses: ['127.0.0.1'], allowInsecure: true })),
    admin,
    probeTable: 't15_probe_' + suffix,
    readerDsn: `postgresql://${reader}:${readerPw}@${host}/${f.database}`,
    deniedDsn: `postgresql://${denied}:${deniedPw}@${host}/${f.database}`,
  }
}

// Local JSON HTTP server helpers. Servers listen on 127.0.0.1 so the egress
// guard's private-range semantics can be exercised without real networks.
async function jsonServer(t, handler) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return { url: 'http://127.0.0.1:' + server.address().port, seen }
}
const rowsBody = rows => (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rows })) }

test('draft lifecycle enforces optimistic CAS, publish history, and credential hygiene', async t => {
  const f = await fixture(t, { sourcesCredentialKeys: credentialKeys() })
  const targets = await postgresTargets(t, f)
  await f.approve(targets.approvals)
  const secret = targets.readerDsn
  const created = await call(f, 'POST', '', { sourceId: 'sales-db', name: 'Sales DB', kind: 'postgres', config: { timezone: 'Asia/Shanghai', maxRows: 10 }, secret }, undefined, 201)
  const draft = created.json()
  assert.equal(draft.sourceId, 'sales-db'); assert.equal(draft.version, 1)
  assert.equal(draft.hasCredential, true); assert.equal(draft.publishedRevision, null)
  assert.equal(draft.hasUnpublishedChanges, false)

  const detail = (await call(f, 'GET', '/sales-db', undefined, undefined, 200)).json()
  assert.equal(detail.source.hasCredential, true)
  assert.equal(detail.config.timezone, 'Asia/Shanghai')
  assert.ok(!JSON.stringify(detail).includes('postgresql://'))

  const listed = (await call(f, 'GET', '?limit=10', undefined, undefined, 200)).json()
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].sourceId, 'sales-db')
  assert.ok(!JSON.stringify(listed).includes('postgresql://'))

  // CAS: a second writer saving the same base version must lose.
  await call(f, 'PUT', '/sales-db', { expectedVersion: 1, name: 'Sales DB v2' }, undefined, 200)
  await call(f, 'PUT', '/sales-db', { expectedVersion: 1, name: 'Stale save' }, undefined, 409)

  const first = (await call(f, 'POST', '/sales-db/publish', { expectedVersion: 2 }, undefined, 200)).json()
  assert.equal(first.revision, 1); assert.match(first.contentHash, /^[0-9a-f]{64}$/)
  let state = (await call(f, 'GET', '/sales-db', undefined, undefined, 200)).json()
  assert.equal(state.source.publishedRevision, 1)
  assert.equal(state.source.hasUnpublishedChanges, false)

  // Draft edits after publishing flip hasUnpublishedChanges until republished.
  await call(f, 'PUT', '/sales-db', { expectedVersion: 2, name: 'Sales DB v3' }, undefined, 200)
  state = (await call(f, 'GET', '/sales-db', undefined, undefined, 200)).json()
  assert.equal(state.source.hasUnpublishedChanges, true)
  assert.equal(state.published.name, 'Sales DB v2')
  const second = (await call(f, 'POST', '/sales-db/publish', { expectedVersion: 3 }, undefined, 200)).json()
  assert.equal(second.revision, 2)
  assert.notEqual(second.contentHash, first.contentHash)
  state = (await call(f, 'GET', '/sales-db', undefined, undefined, 200)).json()
  assert.equal(state.source.hasUnpublishedChanges, false)

  // Stored credentials are ciphertext commitments, never the DSN itself.
  const vault = (await f.inspect('SELECT key_id,ciphertext,secret_hash FROM data_source_credentials WHERE source_id=$1', ['sales-db'])).rows
  assert.equal(vault.length, 1)
  assert.ok(!JSON.stringify(vault[0].ciphertext).includes(secret))
  assert.ok(!JSON.stringify(vault).includes(secret))
  assert.equal(vault[0].secret_hash, createHash('sha256').update(secret).digest('hex'))
  const audit = (await f.inspect('SELECT action FROM data_source_audit WHERE source_id=$1 ORDER BY created_at', ['sales-db'])).rows.map(row => row.action)
  assert.ok(audit.includes('source_created') && audit.includes('source_published'))

  await call(f, 'DELETE', '/sales-db', { expectedVersion: 3 }, undefined, 204)
  await call(f, 'GET', '/sales-db', undefined, undefined, 404)
})

test('cross-tenant source access is invisible and unmodifiable (RLS)', async t => {
  const f = await fixture(t, { sourcesCredentialKeys: credentialKeys() })
  const targets = await postgresTargets(t, f)
  await f.approve(targets.approvals)
  await call(f, 'POST', '', { sourceId: 'private-db', name: 'Alice only', kind: 'postgres', config: {}, secret: targets.readerDsn }, undefined, 201)
  // Bob must see neither existence nor a distinguishable authorization error.
  await call(f, 'GET', '/private-db', undefined, f.bob.token, 404)
  await call(f, 'PUT', '/private-db', { expectedVersion: 1, name: 'Hijack' }, f.bob.token, 404)
  await call(f, 'POST', '/private-db/publish', { expectedVersion: 1 }, f.bob.token, 404)
  await call(f, 'POST', '/private-db/query', { sql: 'SELECT 1' }, f.bob.token, 404)
  await call(f, 'DELETE', '/private-db', { expectedVersion: 1 }, f.bob.token, 404)
  const bobList = (await call(f, 'GET', '', undefined, f.bob.token, 200)).json()
  assert.deepEqual(bobList, { items: [], nextCursor: null })
  const rows = (await f.inspect('SELECT count(*) AS n FROM data_source_versions v JOIN data_sources s ON s.deployment_id=v.deployment_id AND s.owner_id=v.owner_id AND s.source_id=v.source_id AND s.published_revision IS NOT NULL WHERE v.deployment_id=$1 AND v.owner_id=$2', [f.deploymentId, f.alice.user.id])).rows
  assert.equal(Number(rows[0].n), 0)
  await call(f, 'GET', '/private-db', undefined, undefined, 200)
})

test('read-only SQL channel: AST guard, real PG denial, row cap, timeout, units', async t => {
  const f = await fixture(t, { sourcesCredentialKeys: credentialKeys() })
  const targets = await postgresTargets(t, f)
  await f.approve(targets.approvals)
  await call(f, 'POST', '', { sourceId: 'metrics', name: 'Metrics', kind: 'postgres', config: { timezone: 'UTC', maxRows: 3, statementTimeoutMs: 1000, units: { i: 'items' } }, secret: targets.readerDsn }, undefined, 201)
  await call(f, 'POST', '/metrics/publish', { expectedVersion: 1 }, undefined, 200)

  // Bounded rows with truncation and a verifiable evidence hash.
  const snapshot = (await call(f, 'POST', '/metrics/query', { sql: `SELECT i,label,ratio,active,note FROM ${targets.probeTable} ORDER BY i` }, undefined, 200)).json()
  assert.equal(snapshot.sourceId, 'metrics'); assert.equal(snapshot.sourceVersion, 1)
  assert.equal(snapshot.timezone, 'UTC')
  assert.equal(snapshot.rows.length, 3); assert.equal(snapshot.truncated, true)
  assert.deepEqual(snapshot.schema, [
    { name: 'i', type: 'number', unit: 'items' },
    { name: 'label', type: 'string' },
    { name: 'ratio', type: 'number' },
    { name: 'active', type: 'boolean' },
    { name: 'note', type: 'string' },
  ])
  assert.equal(Object.hasOwn(snapshot.schema[1], 'unit'), false)
  assert.deepEqual(snapshot.rows[0], { i: 1, label: 'alpha', ratio: 1.5, active: true, note: null })
  assert.equal(snapshot.sha256, snapshotHash(snapshot))

  // Small result is not truncated.
  const exact = (await call(f, 'POST', '/metrics/query', { sql: `SELECT i FROM ${targets.probeTable} WHERE i=1` }, undefined, 200)).json()
  assert.equal(exact.truncated, false); assert.equal(exact.rows.length, 1)
  const decimal = (await call(f, 'POST', '/metrics/query', { sql: 'SELECT CAST(12.50 AS NUMERIC) AS amount' }, undefined, 200)).json()
  assert.equal(decimal.rows[0].amount, 12.5)
  await call(f, 'POST', '/metrics/query', { sql: "SELECT CAST('0.1234567890123456789' AS NUMERIC) AS amount" }, undefined, 502)
  await call(f, 'POST', '/metrics/query', { sql: "SELECT CAST('9007199254740993' AS BIGINT) AS amount" }, undefined, 502)

  // Syntax-level guard rejects anything that is not a single read-only SELECT.
  for (const sql of [
    `SELECT 1; SELECT 2`,
    `DELETE FROM ${targets.probeTable}`,
    `UPDATE ${targets.probeTable} SET label='x'`,
    `INSERT INTO ${targets.probeTable} VALUES (9,'x',1,true,NULL)`,
    `DROP TABLE ${targets.probeTable}`,
    `SELECT * FROM pg_read_file('/etc/passwd')`,
    `SELECT pg_sleep(3)`,
    `WITH x AS (SELECT 1) INSERT INTO ${targets.probeTable} SELECT * FROM x`,
    `SELECT 1 INTO ${targets.probeTable}`,
    `SELECT dblink('host=127.0.0.1 dbname=x', 'SELECT 1')`,
    `SELECT * FROM pg_ls_dir('.')`,
    `SELECT set_config('default_transaction_read_only','off',false)`,
    `GRANT SELECT ON ${targets.probeTable} TO PUBLIC`,
    '',
  ]) await call(f, 'POST', '/metrics/query', { sql }, undefined, 400)

  // Real PG denial for a structurally valid SELECT outside the reader's grants.
  await call(f, 'POST', '/metrics/query', { sql: 'SELECT count(*) FROM files' }, undefined, 403)

  // A role without CONNECT cannot even establish the session (real PG refusal).
  await call(f, 'POST', '', { sourceId: 'no-connect', name: 'No connect', kind: 'postgres', config: {}, secret: targets.deniedDsn }, undefined, 201)
  await call(f, 'POST', '/no-connect/publish', { expectedVersion: 1 }, undefined, 200)
  await call(f, 'POST', '/no-connect/query', { sql: 'SELECT 1' }, undefined, 403)

  // Read-only transactions reject writes that pass the token guard but not PG.
  await call(f, 'POST', '/metrics/query', { sql: `SELECT count(*) FROM ${targets.probeTable} UNION ALL SELECT 1` }, undefined, 200)

  // A role's default READ ONLY flag cannot conceal an excessive write grant.
  const readerName = decodeURIComponent(new URL(targets.readerDsn).username)
  await targets.admin.query(`GRANT INSERT ON ${targets.probeTable} TO "${readerName}"`)
  await call(f, 'POST', '/metrics/query', { sql: 'SELECT 1' }, undefined, 403)
  await targets.admin.query(`REVOKE INSERT ON ${targets.probeTable} FROM "${readerName}"`)

  // statement_timeout enforced server-side with a genuinely slow real query.
  await call(f, 'POST', '/metrics/query', { sql: 'SELECT count(*) FROM generate_series(1,30000) a, generate_series(1,30000) b' }, undefined, 504)

  // Actual database writes are denied even without the application's SQL parser.
  const direct = new Client({ connectionString: targets.readerDsn })
  await direct.connect()
  try {
    await assert.rejects(direct.query(`INSERT INTO ${targets.probeTable}(i) VALUES(99)`), e => ['25006','42501'].includes(e.code))
    await direct.query('BEGIN READ ONLY')
    await assert.rejects(direct.query(`CREATE TABLE public.t15_forbidden(i integer)`), e => e.code === '25006')
    await direct.query('ROLLBACK')
  } finally { await direct.end() }

  // Input values and target errors never become response diagnostics.
  const sensitiveSql = 'SELECT missing_sensitive_field_credential_probe FROM ' + targets.probeTable
  const failed = await call(f, 'POST', '/metrics/query', { sql: sensitiveSql }, undefined, 502)
  assert.equal(failed.body.includes('missing_sensitive_field'), false)
  assert.equal(failed.body.includes(targets.readerDsn), false)
  await targets.admin.query(`UPDATE ${targets.probeTable} SET note=$1 WHERE i=1`, ['x'.repeat(1_100_000)])
  await call(f, 'POST', '/metrics/query', { sql: `SELECT note FROM ${targets.probeTable} WHERE i=1` }, undefined, 502)
  await targets.admin.query(`UPDATE ${targets.probeTable} SET note=$1 WHERE i=1`, ['x'.repeat(4_000_000)])
  await call(f, 'POST', '/metrics/query', { sql: `SELECT note FROM ${targets.probeTable} WHERE i=1` }, undefined, 502)
  await call(f, 'POST', '/metrics/query', { sql: "SELECT label || label AS big FROM " + targets.probeTable + ' LIMIT 1' }, undefined, 200)

  const check = (await call(f, 'POST', '/metrics/test', {}, undefined, 200)).json()
  assert.deepEqual({ ok: check.ok, kind: check.kind }, { ok: true, kind: 'postgres' })
  const badCheck = (await call(f, 'POST', '/no-connect/test', {}, undefined, 200)).json()
  assert.equal(badCheck.ok, false)
})

test('http connector maps JSON rows with unit metadata and egress guard', async t => {
  const f = await fixture(t, { sourcesCredentialKeys: credentialKeys() })
  const origin = await jsonServer(t, rowsBody([{ amount: 12.5, region: 'north', active: true }, { amount: 8, region: 'south', active: false }]))
  const redirect = await jsonServer(t, (req, res) => res.writeHead(302, { location: origin.url + '/data' }).end())
  const nested = await jsonServer(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ payload: { items: [{ amount: 3, region: 'east', active: null }] } })) })

  await f.approve([httpApproval(origin.url + '/data'), httpApproval(nested.url + '/items')])
  await call(f, 'POST', '', { sourceId: 'feed', name: 'Feed', kind: 'http', config: { timezone: 'Europe/Berlin', maxRows: 1, units: { amount: 'EUR' } }, secret: origin.url + '/data' }, undefined, 201)
  await call(f, 'POST', '/feed/publish', { expectedVersion: 1 }, undefined, 200)
  const snapshot = (await call(f, 'POST', '/feed/query', {}, undefined, 200)).json()
  assert.equal(snapshot.sourceId, 'feed'); assert.equal(snapshot.sourceVersion, 1)
  assert.equal(snapshot.timezone, 'Europe/Berlin')
  assert.deepEqual(snapshot.schema, [{ name: 'amount', type: 'number', unit: 'EUR' }, { name: 'region', type: 'string' }, { name: 'active', type: 'boolean' }])
  assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.truncated, true)
  assert.deepEqual(snapshot.rows[0], { amount: 12.5, region: 'north', active: true })
  assert.equal(snapshot.sha256, snapshotHash(snapshot))

  // rowPath navigation into a nested JSON document.
  await call(f, 'POST', '', { sourceId: 'nested-feed', name: 'Nested', kind: 'http', config: { rowPath: 'payload.items', maxRows: 10 }, secret: nested.url + '/items' }, undefined, 201)
  await call(f, 'POST', '/nested-feed/publish', { expectedVersion: 1 }, undefined, 200)
  const nestedSnapshot = (await call(f, 'POST', '/nested-feed/query', {}, undefined, 200)).json()
  assert.equal(nestedSnapshot.truncated, false)
  assert.deepEqual(nestedSnapshot.rows, [{ amount: 3, region: 'east', active: null }])

  // With no approved target every loopback/link-local URL fails closed.
  await f.approve([])
  for (const [index, target] of [origin.url + '/data', 'http://localhost:' + new URL(origin.url).port + '/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:9/x', redirect.url + '/go'].entries()) {
    const sourceId = 'blocked-' + index
    await call(f, 'POST', '', { sourceId, name: 'Blocked', kind: 'http', config: {}, secret: target }, undefined, 201)
    await call(f, 'POST', '/' + sourceId + '/publish', { expectedVersion: 1 }, undefined, 200)
    await call(f, 'POST', '/' + sourceId + '/query', {}, undefined, 400)
    const check = (await call(f, 'POST', '/' + sourceId + '/test', {}, undefined, 200)).json()
    assert.equal(check.ok, false, target)
  }
})

test('egress allowlist admits pinned addresses and revalidates every redirect hop', async t => {
  const f = await fixture(t, { sourcesCredentialKeys: credentialKeys() })
  const data = await jsonServer(t, rowsBody([{ v: 7 }]))
  const metaHop = await jsonServer(t, (req, res) => res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end())
  const loop = await jsonServer(t, (req, res) => res.writeHead(302, { location: req.url === '/chain' ? req.url + 'x' : req.url + 'x' }).end())
  const viaData = await jsonServer(t, (req, res) => res.writeHead(302, { location: data.url + '/final' }).end())

  await f.approve([data.url + '/final', viaData.url + '/start', metaHop.url + '/go', loop.url + '/chain', loop.url + '/chainx', loop.url + '/chainxx'].map(httpApproval))
  const publishQuery = async (sourceId, secret, payload) => {
    await call(f, 'POST', '', { sourceId, name: sourceId, kind: 'http', config: { maxRows: 10 }, secret }, undefined, 201)
    await call(f, 'POST', '/' + sourceId + '/publish', { expectedVersion: 1 }, undefined, 200)
    return call(f, 'POST', '/' + sourceId + '/query', payload, undefined, 200).then(response => response.json())
  }

  // Allowlisted loopback passes and one legitimate redirect hop works, with no
  // credential or authorization header forwarded across the hop.
  const snapshot = await publishQuery('allowed', data.url + '/final')
  assert.equal(snapshot.rows[0].v, 7); assert.equal(snapshot.truncated, false)
  const redirected = await publishQuery('allowed-redirect', viaData.url + '/start')
  assert.equal(redirected.rows[0].v, 7)
  assert.ok(data.seen.every(hit => hit.authorization === undefined))
  assert.equal(data.seen.some(hit => hit.url === '/final'), true)

  // A redirect into the metadata address is refused on the second hop.
  await call(f, 'POST', '', { sourceId: 'meta-hop', name: 'meta', kind: 'http', config: {}, secret: metaHop.url + '/go' }, undefined, 201)
  await call(f, 'POST', '/meta-hop/publish', { expectedVersion: 1 }, undefined, 200)
  await call(f, 'POST', '/meta-hop/query', {}, undefined, 400)

  // Redirect chains beyond two hops are refused even when every hop is allowed.
  await call(f, 'POST', '', { sourceId: 'chain', name: 'chain', kind: 'http', config: {}, secret: loop.url + '/chain' }, undefined, 201)
  await call(f, 'POST', '/chain/publish', { expectedVersion: 1 }, undefined, 200)
  await call(f, 'POST', '/chain/query', {}, undefined, 400)
})

test('credential rotation keeps previously published versions resolvable', async t => {
  const f = await fixture(t, { sourcesCredentialKeys: credentialKeys() })
  const oldFeed = await jsonServer(t, rowsBody([{ v: 1 }]))
  const newFeed = await jsonServer(t, rowsBody([{ v: 2 }]))
  await f.approve([httpApproval(oldFeed.url + '/v1'), httpApproval(newFeed.url + '/v2')])
  await call(f, 'POST', '', { sourceId: 'rotating', name: 'Rotating', kind: 'http', config: { maxRows: 10 }, secret: oldFeed.url + '/v1' }, undefined, 201)
  await call(f, 'POST', '/rotating/publish', { expectedVersion: 1 }, undefined, 200)
  assert.equal((await call(f, 'POST', '/rotating/query', {}, undefined, 200)).json().rows[0].v, 1)

  // Rotating the credential keeps the old vault row and bumps the revision.
  await call(f, 'PUT', '/rotating', { expectedVersion: 1, secret: newFeed.url + '/v2' }, undefined, 200)
  const vault = (await f.inspect('SELECT credential_ref,revision FROM data_source_credentials WHERE source_id=$1 ORDER BY revision', ['rotating'])).rows
  assert.equal(vault.length, 2); assert.equal(vault[0].revision, 1); assert.equal(vault[1].revision, 2)
  assert.notEqual(vault[0].credential_ref, vault[1].credential_ref)
  assert.equal((await f.inspect('SELECT credential_revision FROM data_source_drafts WHERE source_id=$1', ['rotating'])).rows[0].credential_revision, 2)

  // The still-published revision 1 resolves with its original credential.
  assert.equal((await call(f, 'POST', '/rotating/query', {}, undefined, 200)).json().rows[0].v, 1)
  await call(f, 'POST', '/rotating/publish', { expectedVersion: 2 }, undefined, 200)
  assert.equal((await call(f, 'POST', '/rotating/query', {}, undefined, 200)).json().rows[0].v, 2)
  const pinned = (await call(f, 'POST', '/rotating/query', { sourceVersion: 1 }, undefined, 200)).json()
  assert.equal(pinned.sourceVersion, 1); assert.equal(pinned.rows[0].v, 1)
  await call(f, 'POST', '/rotating/query', { sourceVersion: 9 }, undefined, 404)
})

test('missing credential keys fail closed with explicit 503 while routes stay mounted', async t => {
  const f = await fixture(t, { sourcesCredentialKeys: '' })
  const port = new URL(process.env.DYOFFICE_TEST_DATABASE_URL).port || '5432'
  await call(f, 'POST', '', { sourceId: 'vaultless', name: 'Vaultless', kind: 'postgres', config: {}, secret: `postgresql://nobody:nobody@127.0.0.1:${port}/postgres` }, undefined, 503)
  const httpAttempt = await request(f, 'POST', '', { sourceId: 'vaultless-http', name: 'v', kind: 'http', config: {}, secret: 'http://192.0.2.10/feed' })
  assert.equal(httpAttempt.statusCode, 503)
  assert.deepEqual((await call(f, 'GET', '', undefined, undefined, 200)).json(), { items: [], nextCursor: null })
  await call(f, 'GET', '/vaultless', undefined, undefined, 404)
})
