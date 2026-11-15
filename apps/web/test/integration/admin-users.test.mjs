import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lifecycleFixture, responseAuth, origin } from '../helpers/lifecycle.mjs'
import { password } from '../helpers/identity.mjs'

test('admin creates one normalized pending personal account/workspace and stores only activation hashes', async t => {
  const { create, request, pool, deploymentId, login, redeem } = await lifecycleFixture(t)
  const created = await create('  Alice.Example  ')
  assert.equal(created.user.username, 'alice.example')
  assert.equal(created.user.status, 'pending')
  assert.deepEqual(created.user.roles, ['personal'])
  assert.equal(created.action.purpose, 'activate')
  assert.match(created.action.token, /^[A-Za-z0-9_-]{43}$/)
  const stored = (await pool.query('SELECT * FROM password_action_tokens WHERE deployment_id=$1 AND user_id=$2', [deploymentId, created.user.id])).rows[0]
  assert.equal(stored.token_hash, createHash('sha256').update(created.action.token).digest('hex'))
  assert.equal(JSON.stringify(stored).includes(created.action.token), false)
  assert.equal((await pool.query('SELECT * FROM workspaces WHERE deployment_id=$1 AND owner_id=$2', [deploymentId, created.user.id])).rowCount, 1)
  const listed = await request('GET', '/api/v1/admin/users?limit=1')
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json().users.length, 1)
  assert.equal(JSON.stringify(listed.json()).includes('password'), false)
  assert.equal(JSON.stringify(listed.json()).includes(created.action.token), false)
  assert.equal((await login('alice.example')).statusCode, 401)
  assert.equal((await redeem(created.action)).statusCode, 204)
  const activated = await login('alice.example')
  assert.equal(activated.statusCode, 200)
  const personal = responseAuth(activated)
  assert.equal((await request('GET', '/api/v1/admin/users', undefined, personal)).statusCode, 403)
  assert.equal((await request('POST', '/api/v1/admin/users', { username: 'intruder' }, personal)).statusCode, 403)
})

test('duplicate usernames have one winner under concurrent admin creation and never double-provision', async t => {
  const { request, pool, deploymentId } = await lifecycleFixture(t)
  const outcomes = await Promise.all(['  Alice  ', 'alice'].map(username => request('POST', '/api/v1/admin/users', { username })))
  assert.deepEqual(outcomes.map(x => x.statusCode).sort(), [201, 409])
  const found = (await pool.query("SELECT id FROM users WHERE deployment_id=$1 AND username_normalized='alice'", [deploymentId])).rows
  assert.equal(found.length, 1)
  assert.equal((await pool.query('SELECT * FROM workspaces WHERE deployment_id=$1 AND owner_id=$2', [deploymentId, found[0].id])).rowCount, 1)
  assert.equal((await request('POST', '/api/v1/admin/users', { username: 'forged', roles: ['config_admin'] })).statusCode, 400)
})

test('admin writes require recent password verification and CSRF, while listing remains authorized', async t => {
  const { request, pool, admin, app } = await lifecycleFixture(t)
  const id = (await pool.query('SELECT id FROM sessions WHERE token_hash=$1', [createHash('sha256').update(admin.token).digest('hex')])).rows[0].id
  await pool.query("UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes',reauthenticated_at=NULL WHERE id=$1", [id])
  assert.equal((await request('GET', '/api/v1/admin/users')).statusCode, 200)
  assert.equal((await request('POST', '/api/v1/admin/users', { username: 'alice' })).statusCode, 403)
  const proof = await request('POST', '/api/v1/auth/reauth', { password })
  assert.equal(proof.statusCode, 200)
  Object.assign(admin, responseAuth(proof))
  const missing = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: { cookie: admin.cookie, origin }, payload: { username: 'alice' } })
  assert.equal(missing.statusCode, 403)
  assert.equal((await request('POST', '/api/v1/admin/users', { username: 'alice' })).statusCode, 201)
})

test('disable/restore revoke sessions permanently and role changes do not retain old authority', async t => {
  const { create, redeem, login, request, app } = await lifecycleFixture(t)
  const created = await create('alice')
  assert.equal((await redeem(created.action)).statusCode, 204)
  const initial = responseAuth(await login('alice'))
  const url = '/api/v1/admin/users/' + created.user.id
  assert.equal((await request('PATCH', url, { status: 'disabled' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: initial.cookie } })).statusCode, 401)
  assert.equal((await login('alice')).statusCode, 401)
  assert.equal((await request('PATCH', url, { status: 'active' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: initial.cookie } })).statusCode, 401)
  const restored = responseAuth(await login('alice'))
  assert.equal((await request('PATCH', url, { roles: ['personal', 'config_admin'] })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: restored.cookie } })).statusCode, 401)
  const promoted = responseAuth(await login('alice'))
  assert.equal((await request('GET', '/api/v1/admin/users', undefined, promoted)).statusCode, 200)
  assert.equal((await request('PATCH', url, { roles: ['personal'] })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: promoted.cookie } })).statusCode, 401)
  const demoted = responseAuth(await login('alice'))
  assert.equal((await request('GET', '/api/v1/admin/users', undefined, demoted)).statusCode, 403)
  assert.equal((await request('PATCH', '/api/v1/admin/users/' + randomUUID(), { status: 'disabled' })).statusCode, 404)
})

test('two concurrent self-demotions cannot remove the last active administrator', async t => {
  const { create, redeem, request, login, users, admin, pool, deploymentId, user } = await lifecycleFixture(t)
  assert.equal((await request('PATCH', '/api/v1/admin/users/' + user.id, { roles: ['personal'] })).statusCode, 409)
  const second = await create('second-admin')
  assert.equal((await redeem(second.action)).statusCode, 204)
  assert.equal((await request('PATCH', '/api/v1/admin/users/' + second.user.id, { roles: ['personal', 'config_admin'] })).statusCode, 200)
  const other = responseAuth(await login('second-admin'))
  const outcomes = await Promise.allSettled([
    users.update(admin.token, user.id, { roles: ['personal'] }),
    users.update(other.token, second.user.id, { roles: ['personal'] }),
  ])
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.statusCode, 409)
  const count = await pool.query("SELECT count(*)::int AS count FROM users u JOIN user_roles r ON r.user_id=u.id AND r.deployment_id=u.deployment_id WHERE u.deployment_id=$1 AND u.status='active' AND NOT u.password_reset_required AND r.role='config_admin'", [deploymentId])
  assert.equal(count.rows[0].count, 1)
})

test('mutual administrator resets serialize user/credential locks and do not deadlock', async t => {
  const f = await lifecycleFixture(t)
  const second = await f.create('second-admin'); await f.redeem(second.action)
  await f.request('PATCH', '/api/v1/admin/users/' + second.user.id, { roles: ['personal', 'config_admin'] })
  const other = responseAuth(await f.login('second-admin'))
  const outcomes = await Promise.allSettled([
    f.users.issueReset(f.admin.token, second.user.id),
    f.users.issueReset(other.token, f.user.id),
  ])
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.statusCode, 401)
  const winner = outcomes[0].status === 'fulfilled' ? f.admin : other
  assert.ok(await f.sessions.authenticate(winner.token))
})

test('personal users are rejected before taking administrator row locks', async t => {
  const f = await lifecycleFixture(t)
  const created = await f.create('alice'); await f.redeem(created.action)
  const personal = responseAuth(await f.login('alice'))
  const blocker = await f.pool.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.user.id])
    const result = await f.users.create(personal.token, { username: 'unauthorized' }).then(() => null, error => error)
    assert.equal(result.statusCode, 403)
  } finally { await blocker.query('ROLLBACK'); blocker.release() }
})

test('administrator authority revoked before a waiting mutation is revalidated under its user lock', async t => {
  const f = await lifecycleFixture(t)
  const blocker = await f.pool.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.user.id])
    const outcome = f.users.create(f.admin.token, { username: 'must-not-exist' }).then(() => null, error => error)
    let waited = false
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      if ((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [f.pool.options.application_name])).rowCount) { waited = true; break }
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(waited, true)
    await blocker.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [f.user.id])
    await blocker.query("DELETE FROM user_roles WHERE deployment_id=$1 AND user_id=$2 AND role='config_admin'", [f.deploymentId, f.user.id])
    await blocker.query('COMMIT')
    assert.equal((await outcome).statusCode, 401)
    assert.equal((await f.pool.query("SELECT * FROM users WHERE deployment_id=$1 AND username_normalized='must-not-exist'", [f.deploymentId])).rowCount, 0)
  } finally { await blocker.query('ROLLBACK'); blocker.release() }
})

test('administrator metadata, mutations and secret actions stay within their configured deployment', async t => {
  const a = await lifecycleFixture(t), b = await lifecycleFixture(t)
  const created = await b.create('other-deployment-user')
  await assert.rejects(() => a.users.update(a.admin.token, created.user.id, { status: 'disabled' }), { statusCode: 404 })
  await assert.rejects(() => a.users.issueReset(a.admin.token, b.user.id), { statusCode: 404 })
  await assert.rejects(() => a.users.redeemAction(created.action.token, 'activate', password), { statusCode: 400 })
  const listed = await a.users.list(a.admin.token)
  assert.equal(listed.users.some(row => row.id === created.user.id || row.id === b.user.id), false)
  assert.equal((await b.pool.query('SELECT status FROM users WHERE id=$1', [created.user.id])).rows[0].status, 'pending')
})
