import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPreferenceService } from '../../server/src/modules/preferences/service.ts'
import { restrictedFixture, restrictedOrigin, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { createPrincipalTransactions } from '../../server/src/db/context.ts'
import { assertRuntimePool } from '../../server/src/db/roles.ts'

const credential = token => ({ kind: 'session', token })

test('real runtime roles cannot own tables, bypass RLS, read credential tables or escalate privileges', async t => {
  const f = await restrictedFixture(t)
  await assertRuntimePool(f.authPool, 'auth')
  await assertRuntimePool(f.businessPool, 'business')
  for (const pool of [f.authPool, f.businessPool]) {
    const flags = (await pool.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0]
    assert.deepEqual(flags, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false })
    await assert.rejects(() => pool.query('SET ROLE ' + f.names.owner), { code: '42501' })
    await assert.rejects(() => pool.query('TRUNCATE users'), { code: '42501' })
    await assert.rejects(() => pool.query('CREATE TEMP TABLE unauthorized_temp(id integer)'), { code: '42501' })
  }
  await assert.rejects(() => f.businessPool.query('SELECT password_hash FROM users'), { code: '42501' })
  await assert.rejects(() => f.businessPool.query('SELECT token_hash FROM sessions'), { code: '42501' })
  await assert.rejects(() => f.authPool.query('SELECT * FROM workspaces'), { code: '42501' })
  await assert.rejects(() => f.authPool.query('SELECT * FROM personal_preferences'), { code: '42501' })
  await assert.rejects(() => f.businessPool.query('CREATE TABLE unauthorized(id integer)'), { code: '42501' })
  const rls = (await f.businessPool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=ANY(ARRAY['workspaces'::regclass,'personal_preferences'::regclass]) ORDER BY relname")).rows
  assert.deepEqual(rls, [
    { relname: 'personal_preferences', relrowsecurity: true, relforcerowsecurity: true },
    { relname: 'workspaces', relrowsecurity: true, relforcerowsecurity: true },
  ])
  await assert.rejects(() => assertRuntimePool(f.ownerPool, 'business'))
  const unsafe = createPrincipalTransactions({ pool: f.ownerPool, deploymentId: f.deploymentId })
  await assert.rejects(() => unsafe.withPrincipalTransaction(credential(f.alice.token), async () => 'must reject table-owner pool'))
})

test('A/B/Admin preference HTTP aliases derive ownership from cookies and reject identity injection', async t => {
  const f = await restrictedFixture(t)
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  const headers = signed => ({ origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + signed.token, 'x-csrf-token': csrf.sessionToken(signed.token) })
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/preferences', headers: headers(f.alice), payload: { theme: 'dark', authorName: 'Alice' } })).statusCode, 200)
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/v1/preferences', headers: headers(f.bob), payload: { theme: 'light', authorName: 'Bob' } })).statusCode, 200)
  const a = (await f.app.inject({ method: 'GET', url: '/api/v1/preferences', headers: headers(f.alice) })).json()
  const b = (await f.app.inject({ method: 'GET', url: '/api/preferences', headers: headers(f.bob) })).json()
  assert.equal(a.authorName, 'Alice'); assert.equal(b.authorName, 'Bob')
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/preferences', headers: headers(f.alice), payload: { ownerId: f.bob.user.id, theme: 'dark' } })).statusCode, 400)
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/preferences?ownerId=' + f.bob.user.id, headers: headers(f.alice) })).statusCode, 400)
  const visible = await f.transactions.withPrincipalTransaction(credential(f.adminSigned.token), async (connection, principal) => {
    assert.equal(principal.userId, f.initial.id)
    return (await connection.query('SELECT owner_id FROM personal_preferences')).rows
  })
  assert.equal(visible.some(row => [f.alice.user.id, f.bob.user.id].includes(row.owner_id)), false)
})

test('FORCE RLS rejects cross-owner mutations and composite workspace references without application filters', async t => {
  const f = await restrictedFixture(t)
  await f.preferences.update(f.alice.token, { authorName: 'Alice' })
  await f.preferences.update(f.bob.token, { authorName: 'Bob' })
  assert.equal((await f.businessPool.query('SELECT * FROM personal_preferences')).rowCount, 0)
  const bobWorkspace = await f.transactions.withPrincipalTransaction(credential(f.bob.token), async connection => (await connection.query('SELECT id FROM workspaces')).rows[0].id)
  await f.transactions.withPrincipalTransaction(credential(f.alice.token), async connection => {
    assert.deepEqual((await connection.query('SELECT owner_id FROM personal_preferences')).rows, [{ owner_id: f.alice.user.id }])
    assert.equal((await connection.query('DELETE FROM personal_preferences WHERE owner_id=$1', [f.bob.user.id])).rowCount, 0)
  })
  await assert.rejects(() => f.transactions.withPrincipalTransaction(credential(f.alice.token), connection => connection.query('UPDATE personal_preferences SET owner_id=$1', [f.bob.user.id])), { code: '42501' })
  await assert.rejects(() => f.transactions.withPrincipalTransaction(credential(f.alice.token), connection => connection.query('UPDATE personal_preferences SET workspace_id=$1', [bobWorkspace])), { code: '23503' })
  await assert.rejects(() => f.transactions.withPrincipalTransaction(credential(f.alice.token), connection => connection.query("INSERT INTO personal_preferences(deployment_id,owner_id,workspace_id,data) VALUES($1,$2,$3,'{}')", [f.deploymentId, f.bob.user.id, bobWorkspace])), { code: '42501' })
})

test('pool size one reuses the same backend across A/B/none and clears identity on commit and rollback', async t => {
  const f = await restrictedFixture(t)
  await f.preferences.update(f.alice.token, { authorName: 'Alice' })
  await f.preferences.update(f.bob.token, { authorName: 'Bob' })
  const read = token => f.transactions.withPrincipalTransaction(credential(token), async (connection, principal) => ({ user: principal.userId, pid: (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, owners: (await connection.query('SELECT owner_id FROM personal_preferences')).rows.map(row => row.owner_id) }))
  const a = await read(f.alice.token), b = await read(f.bob.token)
  assert.equal(a.pid, b.pid)
  assert.deepEqual(a.owners, [f.alice.user.id]); assert.deepEqual(b.owners, [f.bob.user.id])
  await assert.rejects(() => f.transactions.withPrincipalTransaction(credential(f.alice.token), async connection => { await connection.query("UPDATE personal_preferences SET data=data||'{\"authorName\":\"rolled back\"}'::jsonb"); throw new Error('controlled callback failure') }), /controlled/)
  await assert.rejects(() => f.transactions.withPrincipalTransaction(credential(f.alice.token), connection => connection.query('SELECT 1/0')), { code: '22012' })
  const none = await f.businessPool.query("SELECT pg_backend_pid() AS pid,NULLIF(current_setting('dyoffice.user_id',true),'') AS user_id,NULLIF(current_setting('dyoffice.deployment_id',true),'') AS deployment_id")
  assert.equal(none.rows[0].pid, a.pid); assert.equal(none.rows[0].user_id, null); assert.equal(none.rows[0].deployment_id, null)
  assert.equal((await f.businessPool.query('SELECT * FROM personal_preferences')).rowCount, 0)
  assert.equal((await f.preferences.get(f.alice.token)).authorName, 'Alice')
})

test('credential input cannot redirect transaction ownership', async t => {
  const f = await restrictedFixture(t)
  const actual = await f.transactions.withPrincipalTransaction({ ...credential(f.alice.token), userId: f.bob.user.id, deploymentId: randomUUID() }, async (_connection, principal) => principal.userId)
  assert.equal(actual, f.alice.user.id)

})

test('runtime admission rejects missing business grants and table grant options', async t => {
  const f = await restrictedFixture(t)
  await f.ownerPool.query('REVOKE SELECT ON workspaces FROM ' + f.names.business)
  await assert.rejects(() => assertRuntimePool(f.businessPool, 'business'))
})

test('runtime admission rejects table privilege delegation rights', async t => {
  const f = await restrictedFixture(t)
  await f.ownerPool.query('GRANT SELECT ON users TO ' + f.names.auth + ' WITH GRANT OPTION')
  await assert.rejects(() => assertRuntimePool(f.authPool, 'auth'))
})

test('runtime admission rejects column leaks, column delegation and excess allowed-table grants', async t => {
  const f = await restrictedFixture(t)
  for (const [pool, kind, statement, revoke] of [
    [f.businessPool, 'business', 'GRANT SELECT(password_hash) ON users TO ', 'REVOKE SELECT(password_hash) ON users FROM '],
    [f.authPool, 'auth', 'GRANT SELECT(data) ON personal_preferences TO ', 'REVOKE SELECT(data) ON personal_preferences FROM '],
    [f.authPool, 'auth', 'GRANT SELECT(username_normalized) ON users TO ', 'REVOKE GRANT OPTION FOR SELECT(username_normalized) ON users FROM '],
    [f.businessPool, 'business', 'GRANT UPDATE ON workspaces TO ', 'REVOKE UPDATE ON workspaces FROM '],
  ]) {
    const role = f.names[kind]
    await f.ownerPool.query(statement + role + (statement.includes('username_normalized') ? ' WITH GRANT OPTION' : ''))
    await assert.rejects(() => assertRuntimePool(pool, kind))
    await f.ownerPool.query(revoke + role)
  }
  await f.ownerPool.query('GRANT EXECUTE ON FUNCTION lock_business_session(uuid,text,bigint) TO ' + f.names.business + ' WITH GRANT OPTION')
  await assert.rejects(() => assertRuntimePool(f.businessPool, 'business'))
})


test('overlapping preference patches preserve both fields after an observed row lock wait', { timeout: 15_000 }, async t => {
  const f = await restrictedFixture(t)
  const pool = new Pool({ connectionString: f.urls.business, max: 2, application_name: f.businessPool.options.application_name })
  f.cleanup.push(() => pool.end())
  const transactions = createPrincipalTransactions({ pool, deploymentId: f.deploymentId })
  let ready, release
  const entered = new Promise(resolve => { ready = resolve }), barrier = new Promise(resolve => { release = resolve })
  const holding = createPreferenceService({ withPrincipalTransaction: (credential, callback) => transactions.withPrincipalTransaction(credential, async (...args) => {
    const result = await callback(...args)
    ready(); await barrier
    return result
  }) })
  const first = holding.update(f.alice.token, { theme: 'dark' })
  let second
  try {
    await Promise.race([entered, first.then(() => { throw new Error('Writer ended before barrier') })])
    second = createPreferenceService(transactions).update(f.alice.token, { authorName: 'Alice' })
    await waitForDatabaseLock(f, 'business')
    release(); await first; await second
    const data = await f.preferences.get(f.alice.token)
    assert.equal(data.theme, 'dark'); assert.equal(data.authorName, 'Alice')
  } finally { release(); await Promise.allSettled([first, second].filter(Boolean)) }
})
