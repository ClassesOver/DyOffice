import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createAccountLifecycle } from '../server/auth/account-lifecycle.mjs'

const deploymentId = randomUUID()
const actorId = randomUUID()
const sessionId = randomUUID()
const userId = randomUUID()
const adminPassword = 'A secret administrator passphrase'
const newPassword = 'A different long passphrase 2026!'
const phc = '$argon2id$v=19$m=19456,t=2,p=1$' + 'A'.repeat(22) + '$' + 'B'.repeat(43)
const request = { headers: { cookie: 'server-validated-session' }, socket: { remoteAddress: '127.0.0.1' } }
const isCode = code => error => error?.code === code

function fixture() {
  const actor = { id: actorId, session_id: sessionId, deployment_id: deploymentId,
    username_normalized: 'operator.admin', auth_version: '1', password_hash: phc }
  const grant = { id: randomUUID(), user_id: userId, purpose: 'activate', auth_version: '1', status: 'pending' }
  const state = { actor, liveActor: actor, grant,
    target: { id: userId, status: 'active', password_hash: phc },
    principal: { sessionId, userId: actorId, deploymentId }, csrf: true, passwordValid: true,
    allowed: true, failAudit: false, failRollback: false, consumed: false,
    calls: [], releaseErrors: [], hashes: 0, verifies: 0,
    listed: [{ id: userId, username_normalized: 'alice.user', display_name: 'Alice', status: 'pending', roles: ['user'], password_hash: phc }],
    revoked: [] }
  const query = async (sql, params = []) => {
    state.calls.push({ sql, params })
    const label = /\/\* account:([a-z_-]+) \*\//.exec(sql)?.[1]
    const one = row => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] })
    if (sql === 'ROLLBACK' && state.failRollback) throw new Error('rollback failed')
    if (label === 'actor') return one(state.actor)
    if (label === 'actor_lock') return one(state.liveActor)
    if (label === 'target_lock') return one(state.target)
    if (label === 'create_user') return one({ id: params[0], username_normalized: params[2], status: 'pending' })
    if (label === 'issue_token') return one({ expires_at: new Date(Date.now() + 900_000) })
    if (label === 'lookup_token' || label === 'token_lock') return one(state.consumed ? null : state.grant)
    if (label === 'consume_token') { state.consumed = true; return one({ id: state.grant.id }) }
    if (label === 'audit' && state.failAudit) throw Object.assign(new Error('sensitive SQL detail'), { code: 'XX000' })
    if (label === 'list_actor') return one(state.actor)
    if (label === 'list') return { rowCount: state.listed.length, rows: state.listed }
    return { rowCount: 1, rows: [] }
  }
  const pool = { query: (sql, params) => query(sql, params),
    async connect() { return { query, release(error) { state.releaseErrors.push(error) } } } }
  const dependencies = { pool, deploymentId,
    sessionService: { async authenticate() { return state.principal } },
    csrfPolicy: { verify() { return state.csrf } },
    throttle: { async consume() { return { allowed: state.allowed } } },
    passwordHasher: {
      async verifyPassword(hash, password) { state.verifies++; assert.equal(password, adminPassword); return state.passwordValid },
      async hashPassword(password) { state.hashes++; assert.equal(password, newPassword); return phc },
    },
    onCredentialsRevoked: async (event) => { state.revoked.push(event) },
  }
  return { state, dependencies, service: createAccountLifecycle(dependencies) }
}

const createInput = { username: ' Alice.User ', displayName: ' Alice ', adminPassword }

test('constructor rejects unsafe dependencies, deployment and token lifetimes', () => {
  const { dependencies } = fixture()
  assert.throws(() => createAccountLifecycle({ ...dependencies, csrfPolicy: null }), TypeError)
  assert.throws(() => createAccountLifecycle({ ...dependencies, deploymentId: 'client-input' }), TypeError)
  assert.throws(() => createAccountLifecycle({ ...dependencies, tokenLifetimeMs: 0 }), TypeError)
  assert.throws(() => createAccountLifecycle({ ...dependencies, tokenLifetimeMs: 86_400_000 }), TypeError)
})

test('account creation requires live session, CSRF, admin role, throttle and fresh password', async () => {
  for (const [mutate, code] of [
    [s => { s.principal = null }, 'UNAUTHORIZED'],
    [s => { s.csrf = false }, 'FORBIDDEN'],
    [s => { s.actor = null }, 'FORBIDDEN'],
    [s => { s.allowed = false }, 'RATE_LIMITED'],
    [s => { s.passwordValid = false }, 'REAUTHENTICATION_REQUIRED'],
  ]) {
    const f = fixture(); mutate(f.state)
    await assert.rejects(f.service.createAccount(request, createInput), isCode(code))
    assert.equal(f.state.calls.some(c => c.sql === 'BEGIN'), false)
  }
})

test('creates pending user, personal workspace and single user role atomically; only hash reaches DB', async () => {
  const f = fixture()
  const created = await f.service.createAccount(request, createInput)
  assert.equal(created.username, 'alice.user')
  assert.equal(created.status, 'pending')
  assert.match(created.activationToken, /^[A-Za-z0-9_-]{43}$/)
  const sql = f.state.calls.map(c => c.sql)
  assert.equal(sql.includes('BEGIN'), true)
  assert.equal(sql.at(-1), 'COMMIT')
  assert.ok(sql.some(q => q.includes('pg_advisory_xact_lock')))
  const role = f.state.calls.find(c => c.sql.includes('account:create_role'))
  assert.equal(role.params.at(-1), 'user')
  const action = f.state.calls.find(c => c.sql.includes('account:issue_token'))
  const digest = createHash('sha256').update(created.activationToken).digest()
  assert.ok(action.params.some(p => Buffer.isBuffer(p) && p.equals(digest)))
  const recorded = JSON.stringify(f.state.calls)
  assert.equal(recorded.includes(created.activationToken), false)
  assert.equal(recorded.includes(adminPassword), false)
  assert.equal(f.state.verifies, 1)
  assert.equal(f.state.releaseErrors.length, 1)
})

test('transaction rechecks administrator password/version after concurrent account changes', async () => {
  for (const liveActor of [null, { id: actorId, auth_version: '2', password_hash: phc },
    { id: actorId, auth_version: '1', password_hash: 'changed' }]) {
    const f = fixture(); f.state.liveActor = liveActor
    await assert.rejects(f.service.createAccount(request, createInput), isCode('REAUTHENTICATION_REQUIRED'))
    assert.equal(f.state.calls.at(-1).sql, 'ROLLBACK')
    assert.equal(f.state.calls.some(c => c.sql.includes('account:create_user')), false)
  }
})

test('audit failure aborts the transaction and a failed rollback discards the pooled connection', async () => {
  const f = fixture(); f.state.failAudit = true; f.state.failRollback = true
  await assert.rejects(f.service.createAccount(request, createInput), error => {
    assert.equal(error.code, 'UNAVAILABLE')
    assert.equal(String(error).includes('sensitive SQL detail'), false)
    return true
  })
  assert.equal(f.state.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(f.state.releaseErrors[0] instanceof Error)
  assert.equal(f.state.calls.some(c => c.sql === 'COMMIT'), false)
})

test('rejects role injection, self-disable and invalid target IDs without mutating accounts', async () => {
  const f = fixture()
  await assert.rejects(f.service.createAccount(request, { ...createInput, role: 'config_admin' }), isCode('INVALID_INPUT'))
  await assert.rejects(f.service.setAccountEnabled(request, { userId: actorId, enabled: false, adminPassword }), isCode('SELF_ACTION_FORBIDDEN'))
  await assert.rejects(f.service.issuePasswordReset(request, { userId: 'bad', adminPassword }), isCode('INVALID_INPUT'))
  assert.equal(f.state.calls.some(c => c.sql.includes('account:set_status')), false)
})

test('disabling a target advances authority version, revokes sessions/tokens and audits together', async () => {
  const f = fixture()
  assert.deepEqual(await f.service.setAccountEnabled(request, { userId, enabled: false, adminPassword }),
    { userId, status: 'disabled' })
  for (const name of ['set_status', 'revoke_sessions', 'revoke_tokens', 'audit']) {
    assert.ok(f.state.calls.some(c => c.sql.includes('account:' + name)), name)
  }
  assert.equal(f.state.calls.at(-1).sql, 'COMMIT')
})

test('admin reset suspends old credentials and invalidates earlier action links', async () => {
  const f = fixture()
  const issued = await f.service.issuePasswordReset(request, { userId, adminPassword })
  assert.match(issued.resetToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(issued.status, 'pending')
  const suspend = f.state.calls.find(c => c.sql.includes('account:suspend_password'))
  assert.match(suspend.sql, /password_hash = NULL/)
  assert.match(suspend.sql, /auth_version = auth_version \+ 1/)
  assert.ok(f.state.calls.find(c => c.sql.includes('account:revoke_sessions')))
  assert.equal(JSON.stringify(f.state.calls).includes(issued.resetToken), false)
})

test('invalid or unknown action tokens cannot invoke Argon2 or mutate the DB', async () => {
  const f = fixture(); f.state.grant = null
  for (const token of ['not-a-token', randomBytes(32).toString('base64url')]) {
    await assert.rejects(f.service.redeemPasswordAction(request, { token, newPassword }), isCode('INVALID_ACTION'))
  }
  assert.equal(f.state.hashes, 0)
  assert.equal(f.state.calls.some(c => c.sql === 'BEGIN'), false)
})

test('action redemption consumes a token once and requires a new login instead of issuing a cookie', async () => {
  const f = fixture()
  const token = randomBytes(32).toString('base64url')
  const result = await f.service.redeemPasswordAction(request, { token, newPassword })
  assert.deepEqual(result, { userId, requiresLogin: true })
  assert.equal(f.state.hashes, 1)
  assert.equal(f.state.calls.at(-1).sql, 'COMMIT')
  assert.equal(JSON.stringify(f.state.calls).includes(token), false)
  assert.equal(JSON.stringify(f.state.calls).includes(newPassword), false)
  await assert.rejects(f.service.redeemPasswordAction(request, { token, newPassword }), isCode('INVALID_ACTION'))
  assert.equal(f.state.hashes, 1)
})

test('uppercase deployment configuration matches the lowercase session principal', async () => {
  const f = fixture()
  const service = createAccountLifecycle({ ...f.dependencies, deploymentId: deploymentId.toUpperCase() })
  const created = await service.createAccount(request, createInput)
  assert.equal(created.username, 'alice.user')
  const insert = f.state.calls.find(call => call.sql.includes('account:create_user'))
  assert.equal(insert.params[1], deploymentId)
})

test('role changes replace only the target roles and do not grant admin on create', async () => {
  const f = fixture()
  await assert.rejects(f.service.setRoles(request, { userId, roles: ['config_admin', 'config_admin'], adminPassword }), isCode('INVALID_INPUT'))
  await assert.rejects(f.service.setRoles(request, { userId: actorId, roles: ['user'], adminPassword }), isCode('SELF_ACTION_FORBIDDEN'))
  assert.deepEqual(await f.service.setRoles(request, { userId, roles: ['user', 'auditor'], adminPassword }),
    { userId, roles: ['auditor', 'user'] })
  const assigned = f.state.calls.filter(call => call.sql.includes('account:assign_role')).map(call => call.params.at(-1))
  assert.deepEqual(assigned, ['auditor', 'user'])
  assert.equal(f.state.calls.some(call => call.sql.includes('account.role_changed') || call.params?.includes('account.role_changed')), true)
  assert.deepEqual(f.state.revoked.at(-1), { deploymentId, userId })
  assert.equal(JSON.stringify(f.state.calls).includes(adminPassword), false)
})

test('admin user list is session scoped and omits password hashes and file data', async () => {
  const f = fixture()
  const page = await f.service.listUsers(request, { limit: 1 })
  assert.equal(page.users.length, 1)
  assert.equal(page.users[0].username, 'alice.user')
  assert.equal(Object.hasOwn(page.users[0], 'password_hash'), false)
  assert.equal(JSON.stringify(page).includes(phc), false)
  assert.equal(JSON.stringify(page).includes('file'), false)
  assert.deepEqual(page.nextCursor, { username: 'alice.user', id: userId })
  f.state.principal = null
  await assert.rejects(f.service.listUsers(request, {}), isCode('UNAUTHORIZED'))
  assert.equal(f.state.calls.some(call => call.sql.includes('account:list ')), true)
})
