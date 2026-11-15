import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lifecycleFixture, nextPassword, responseAuth } from '../helpers/lifecycle.mjs'
import { password } from '../helpers/identity.mjs'

test('activation validates policy/purpose and has exactly one concurrent consumer', async t => {
  const { create, redeem, login, pool } = await lifecycleFixture(t)
  const created = await create('alice')
  assert.equal((await redeem(created.action, 'short')).statusCode, 400)
  assert.equal((await redeem({ ...created.action, purpose: 'reset' })).statusCode, 400)
  const outcomes = await Promise.all([redeem(created.action), redeem(created.action)])
  assert.deepEqual(outcomes.map(x => x.statusCode).sort(), [204, 400])
  assert.equal((await login('alice')).statusCode, 200)
  assert.equal((await redeem(created.action)).statusCode, 400)
  assert.equal((await pool.query('SELECT auth_version FROM users WHERE id=$1', [created.user.id])).rows[0].auth_version, 2)
})

test('reset issuance freezes old-password login and revokes sessions before one-use redemption', async t => {
  const { create, redeem, login, request, app, pool } = await lifecycleFixture(t)
  const created = await create('alice')
  await redeem(created.action)
  const before = responseAuth(await login('alice'))
  const issued = await request('POST', '/api/v1/admin/users/' + created.user.id + '/password-reset')
  assert.equal(issued.statusCode, 200)
  const action = issued.json().action
  assert.equal(action.purpose, 'reset')
  assert.equal((await login('alice')).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: before.cookie } })).statusCode, 401)
  assert.equal((await redeem(action, nextPassword)).statusCode, 204)
  assert.equal((await login('alice', nextPassword)).statusCode, 200)
  assert.equal((await login('alice', password)).statusCode, 401)
  assert.equal((await redeem(action, nextPassword)).statusCode, 400)
  const state = (await pool.query('SELECT password_reset_required FROM users WHERE id=$1', [created.user.id])).rows[0]
  assert.equal(state.password_reset_required, false)
})

test('reissued/expired/disabled action tokens stay invalid and a fresh valid reset can recover', async t => {
  const { create, redeem, request, pool } = await lifecycleFixture(t)
  const created = await create('alice')
  const url = '/api/v1/admin/users/' + created.user.id
  const reissued = await request('POST', url + '/activation')
  assert.equal(reissued.statusCode, 200)
  assert.equal((await redeem(created.action)).statusCode, 400)
  const latest = reissued.json().action
  await pool.query("UPDATE password_action_tokens SET created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [created.user.id])
  assert.equal((await redeem(latest)).statusCode, 400)
  const fresh = (await request('POST', url + '/activation')).json().action
  assert.equal((await request('PATCH', url, { status: 'disabled' })).statusCode, 200)
  assert.equal((await redeem(fresh)).statusCode, 400)
  assert.equal((await request('PATCH', url, { status: 'active' })).statusCode, 200)
  const recovery = (await request('POST', url + '/activation')).json().action
  assert.equal((await redeem(recovery)).statusCode, 204)
})

test('password change verifies the old password, revokes all old sessions and mints a new cookie', async t => {
  const { create, redeem, login, request, app } = await lifecycleFixture(t)
  const created = await create('alice'); await redeem(created.action)
  const first = responseAuth(await login('alice')), second = responseAuth(await login('alice'))
  assert.equal((await request('POST', '/api/v1/auth/change-password', { currentPassword: 'wrong phrase here', newPassword: nextPassword }, first)).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: first.cookie } })).statusCode, 200)
  const changed = await request('POST', '/api/v1/auth/change-password', { currentPassword: password, newPassword: nextPassword }, first)
  assert.equal(changed.statusCode, 200)
  const fresh = responseAuth(changed)
  for (const old of [first, second]) assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: old.cookie } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: fresh.cookie } })).statusCode, 200)
  assert.equal((await login('alice', password)).statusCode, 401)
  assert.equal((await login('alice', nextPassword)).statusCode, 200)
})

test('failure after password/action changes rolls the whole reset transaction back', async t => {
  const { create, redeem, request, pool, cleanup } = await lifecycleFixture(t)
  const created = await create('alice'); await redeem(created.action)
  const action = (await request('POST', '/api/v1/admin/users/' + created.user.id + '/password-reset')).json().action
  const suffix = randomUUID().replaceAll('-', ''), trigger = 'fault_' + suffix, fn = 'fail_' + suffix
  await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='password_action_consumed' AND NEW.subject_user_id='${created.user.id}'::uuid THEN RAISE EXCEPTION 'controlled test fault'; END IF; RETURN NEW; END $$`)
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON auth_security_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
  cleanup.push(async () => { await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON auth_security_events`); await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`) })
  assert.equal((await redeem(action, nextPassword)).statusCode, 500)
  const row = (await pool.query('SELECT consumed_at FROM password_action_tokens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [created.user.id])).rows[0]
  assert.equal(row.consumed_at, null)
  assert.equal((await pool.query('SELECT password_reset_required FROM users WHERE id=$1', [created.user.id])).rows[0].password_reset_required, true)
  await pool.query(`DROP TRIGGER ${trigger} ON auth_security_events`)
  assert.equal((await redeem(action, nextPassword)).statusCode, 204)
})

test('an administrator reset committed after real password hashing prevents a stale self-change', async t => {
  const f = await lifecycleFixture(t)
  const created = await f.create('alice'); await f.redeem(created.action)
  const alice = responseAuth(await f.login('alice'))
  const { createUserService } = await import('../../server/src/modules/admin/users/service.ts')
  let prepared, release
  const hashed = new Promise(resolve => { prepared = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const passwords = { ...f.passwords, async hash(value) { const encoded = await f.passwords.hash(value); prepared(); await gate; return encoded } }
  const gated = createUserService({ ...f, passwords })
  const outcome = gated.changePassword(alice.token, password, nextPassword).then(() => null, error => error)
  await hashed
  try {
    await f.users.issueReset(f.admin.token, created.user.id)
  } finally { release() }
  assert.equal((await outcome).statusCode, 401)
  const user = (await f.pool.query('SELECT password_hash,password_reset_required FROM users WHERE id=$1', [created.user.id])).rows[0]
  assert.equal(user.password_reset_required, true)
  assert.equal(await f.passwords.verifyCandidate(password, user.password_hash), true)
  assert.equal(await f.passwords.verifyCandidate(nextPassword, user.password_hash), false)
})

test('runtime password blocklist files apply to account activation rather than bootstrap alone', async t => {
  const f = await lifecycleFixture(t)
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomBytes } = await import('node:crypto')
  const { buildLocalApp } = await import('../../server/src/app.ts')
  const { origin } = await import('../helpers/lifecycle.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-blocklist-')), file = join(directory, 'deny.txt')
  const blocked = 'customer blocked credential phrase 8146'
  await writeFile(file, blocked + '\n')
  const app = await buildLocalApp({ db: f.db, deploymentId: f.deploymentId, origin, csrfKey: randomBytes(32).toString('hex'), passwordBlocklistFile: file })
  f.cleanup.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const created = await f.create('alice')
  const c = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' })
  const cookie = c.headers['set-cookie'].find(value => value.startsWith('__Host-dyoffice-login=')).split(';')[0]
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/password-action', headers: { origin, cookie, 'x-csrf-token': c.json().csrfToken }, payload: { token: created.action.token, purpose: 'activate', password: blocked } })
  assert.equal(response.statusCode, 400)
})
