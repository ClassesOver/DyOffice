import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { applyMigrations } from '../../server/db/migrate.mjs'
import { bootstrapInitialAdmin } from '../../server/auth/bootstrap-admin.mjs'
import { createPasswordHasher } from '../../server/auth/passwords.mjs'
import { createSessionService } from '../../server/auth/session-core.mjs'
import { createCsrfPolicy } from '../../server/auth/csrf-policy.mjs'
import { createPgLoginThrottle } from '../../server/auth/login-throttle.mjs'
import { createLocalLoginService } from '../../server/auth/login-service.mjs'
import { createAccountLifecycle } from '../../server/auth/account-lifecycle.mjs'

const connectionString = process.env.DYOFFICE_TEST_DATABASE_URL
if (!connectionString) throw new Error('DYOFFICE_TEST_DATABASE_URL required; use a disposable PostgreSQL database')
const origin = 'https://office.example.test'
const adminPassword = 'This is the operator passphrase 🦉 2026'
const initialPassword = 'This is a new private account password 2026'
const replacementPassword = 'This is a different replacement password 2026'
const isCode = code => error => error?.code === code
const hashToken = value => createHash('sha256').update(value).digest()

// A separate schema lets this suite run in the shared test database without
// depending on the execution order of other workers' identity tests.
test('account lifecycle uses real PostgreSQL, Argon2id, sessions and CSRF', { timeout: 120_000 }, async t => {
  const schema = 'lifecycle_' + randomBytes(8).toString('hex')
  const root = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 })
  let pool
  try {
    await root.query(`CREATE SCHEMA "${schema}"`)
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public`,
      connectionTimeoutMillis: 5000, statement_timeout: 20000 })
    assert.deepEqual(await applyMigrations(pool), ['0001_identity.sql', '0002_login_rate_limits.sql', '0003_files.sql', '0004_revisions.sql', '0005_account_lifecycle_audit.sql', '0006_self_password_change.sql', '0007_session_security_events.sql', '0008_account_roles.sql'])
    assert.deepEqual(await applyMigrations(pool), [])
    const deploymentId = randomUUID()
    const hasher = createPasswordHasher({ maxConcurrent: 4 })
    const admin = await bootstrapInitialAdmin({ pool, passwordHasher: hasher, deploymentId,
      username: 'operator.admin', displayName: 'Operator', password: adminPassword })
    const sessions = createSessionService({ pool })
    const csrf = createCsrfPolicy({ secret: randomBytes(32), trustedOrigin: origin })
    const throttle = createPgLoginThrottle({ pool, hmacKey: randomBytes(32), limits: {
      global: { maxAttempts: 1000, windowMs: 60_000 }, ip: { maxAttempts: 500, windowMs: 60_000 },
      account: { maxAttempts: 200, windowMs: 60_000 },
    } })
    const dependencies = { pool, passwordHasher: hasher, sessionService: sessions, csrfPolicy: csrf, throttle, deploymentId }
    const lifecycle = createAccountLifecycle(dependencies)
    const operatorSession = await sessions.issue({ deploymentId, userId: admin.userId })
    function req(session) {
      const cookie = session.cookie.split(';')[0]
      const token = csrf.issue({ sessionId: session.sessionId, deploymentId })
      return { headers: { cookie, origin, 'x-dyoffice-csrf': token },
        rawHeaders: ['Cookie', cookie, 'Origin', origin, 'X-DyOffice-CSRF', token], socket: { remoteAddress: '127.0.0.1' } }
    }
    const operatorRequest = req(operatorSession)
    const anonymous = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    const login = await createLocalLoginService({ pool, passwordHasher: hasher, sessionService: sessions, throttle, deploymentId })
    const rows = async (sql, args = []) => (await pool.query(sql, args)).rows
    const user = async id => (await rows('SELECT * FROM dyoffice_users WHERE id=$1', [id]))[0]
    const create = async name => lifecycle.createAccount(operatorRequest,
      { username: name, displayName: name, adminPassword })
    let alice, aliceLogin

    await t.test('create pending account with one personal workspace, no admin role and no stored token plaintext', async () => {
      alice = await create(' Alice.Local ')
      assert.equal(alice.username, 'alice.local')
      assert.equal(alice.status, 'pending')
      const saved = await user(alice.userId)
      assert.equal(saved.password_hash, null)
      assert.deepEqual((await rows('SELECT role FROM dyoffice_user_roles WHERE user_id=$1', [alice.userId])).map(r => r.role), ['user'])
      assert.equal((await rows('SELECT id FROM dyoffice_personal_workspaces WHERE owner_user_id=$1', [alice.userId])).length, 1)
      const stored = (await rows('SELECT * FROM dyoffice_password_action_tokens WHERE user_id=$1', [alice.userId]))[0]
      assert.ok(stored.token_hash.equals(hashToken(alice.activationToken)))
      assert.equal(JSON.stringify(stored).includes(alice.activationToken), false)
      assert.equal(await sessions.issue({ deploymentId, userId: alice.userId }), null)
      assert.equal((await login.login({ username: 'alice.local', password: initialPassword, ipAddress: '127.0.0.1' })).code, 'INVALID_CREDENTIALS')
    })

    await t.test('activation is single-use and enables a real Argon2id login without automatically creating a session', async () => {
      assert.deepEqual(await lifecycle.redeemPasswordAction(anonymous, { token: alice.activationToken, newPassword: initialPassword }),
        { userId: alice.userId, requiresLogin: true })
      assert.equal((await rows('SELECT id FROM dyoffice_sessions WHERE user_id=$1', [alice.userId])).length, 0)
      assert.equal(await hasher.verifyPassword((await user(alice.userId)).password_hash, initialPassword), true)
      await assert.rejects(lifecycle.redeemPasswordAction(anonymous, { token: alice.activationToken, newPassword: initialPassword }), isCode('INVALID_ACTION'))
      aliceLogin = await login.login({ username: 'alice.local', password: initialPassword, ipAddress: '127.0.0.1' })
      assert.equal(aliceLogin.ok, true)
      assert.equal((await sessions.authenticate(req(aliceLogin), { deploymentId })).userId, alice.userId)
    })

    await t.test('ordinary users, missing CSRF and wrong administrator password cannot create accounts', async () => {
      await assert.rejects(lifecycle.createAccount(req(aliceLogin), { username: 'injected.admin', displayName: 'Bad', adminPassword: initialPassword }), isCode('FORBIDDEN'))
      const missingCsrf = { ...operatorRequest, headers: { cookie: operatorRequest.headers.cookie } }
      await assert.rejects(lifecycle.createAccount(missingCsrf, { username: 'bad.csrf', displayName: 'Bad', adminPassword }), isCode('FORBIDDEN'))
      await assert.rejects(lifecycle.createAccount(operatorRequest, { username: 'bad.password', displayName: 'Bad', adminPassword: initialPassword }), isCode('REAUTHENTICATION_REQUIRED'))
      await assert.rejects(lifecycle.createAccount(operatorRequest, { username: 'bad.role', displayName: 'Bad', adminPassword, role: 'config_admin' }), isCode('INVALID_INPUT'))
      assert.equal((await rows("SELECT id FROM dyoffice_users WHERE username_normalized LIKE 'bad.%'")).length, 0)
    })

    await t.test('administrator reset suspends old login, revokes old sessions and replaces earlier action links', async () => {
      const first = await lifecycle.issuePasswordReset(operatorRequest, { userId: alice.userId, adminPassword })
      assert.equal((await user(alice.userId)).status, 'pending')
      assert.equal((await user(alice.userId)).password_hash, null)
      assert.equal(await sessions.authenticate(req(aliceLogin), { deploymentId }), null)
      assert.equal((await login.login({ username: 'alice.local', password: initialPassword, ipAddress: '127.0.0.1' })).code, 'INVALID_CREDENTIALS')
      const second = await lifecycle.issuePasswordReset(operatorRequest, { userId: alice.userId, adminPassword })
      await assert.rejects(lifecycle.redeemPasswordAction(anonymous, { token: first.resetToken, newPassword: replacementPassword }), isCode('INVALID_ACTION'))
      assert.ok((await rows('SELECT revoked_at FROM dyoffice_password_action_tokens WHERE token_hash=$1', [hashToken(first.resetToken)]))[0].revoked_at)
      await lifecycle.redeemPasswordAction(anonymous, { token: second.resetToken, newPassword: replacementPassword })
      assert.equal(await hasher.verifyPassword((await user(alice.userId)).password_hash, replacementPassword), true)
      assert.equal((await login.login({ username: 'alice.local', password: initialPassword, ipAddress: '127.0.0.1' })).ok, false)
    })

    await t.test('two concurrent redemptions commit exactly one password/action event', async () => {
      const reset = await lifecycle.issuePasswordReset(operatorRequest, { userId: alice.userId, adminPassword })
      const passwords = [initialPassword, replacementPassword]
      const outcomes = await Promise.allSettled(passwords.map(newPassword =>
        lifecycle.redeemPasswordAction(anonymous, { token: reset.resetToken, newPassword })))
      assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(outcomes.filter(r => r.status === 'rejected' && r.reason.code === 'INVALID_ACTION').length, 1)
      const winner = outcomes.findIndex(r => r.status === 'fulfilled')
      assert.equal(await hasher.verifyPassword((await user(alice.userId)).password_hash, passwords[winner]), true)
      const action = (await rows('SELECT consumed_at FROM dyoffice_password_action_tokens WHERE token_hash=$1', [hashToken(reset.resetToken)]))[0]
      assert.ok(action.consumed_at)
    })

    await t.test('disable and enable invalidate sessions without resurrecting old action links or sessions', async () => {
      const issued = await sessions.issue({ deploymentId, userId: alice.userId })
      const disabled = await lifecycle.setAccountEnabled(operatorRequest, { userId: alice.userId, enabled: false, adminPassword })
      assert.equal(disabled.status, 'disabled')
      assert.equal(await sessions.authenticate(req(issued), { deploymentId }), null)
      assert.equal(await sessions.issue({ deploymentId, userId: alice.userId }), null)
      await assert.rejects(lifecycle.issuePasswordReset(operatorRequest, { userId: alice.userId, adminPassword }), isCode('ACCOUNT_DISABLED'))
      const enabled = await lifecycle.setAccountEnabled(operatorRequest, { userId: alice.userId, enabled: true, adminPassword })
      assert.equal(enabled.status, 'active')
      assert.equal(await sessions.authenticate(req(issued), { deploymentId }), null)
      assert.ok(await sessions.issue({ deploymentId, userId: alice.userId }))
      await assert.rejects(lifecycle.setAccountEnabled(operatorRequest, { userId: admin.userId, enabled: false, adminPassword }), isCode('SELF_ACTION_FORBIDDEN'))
    })

    await t.test('pending users remain pending after enable; cross-deployment targets are not found', async () => {
      const pending = await create('pending.user')
      await lifecycle.setAccountEnabled(operatorRequest, { userId: pending.userId, enabled: false, adminPassword })
      assert.equal((await lifecycle.setAccountEnabled(operatorRequest, { userId: pending.userId, enabled: true, adminPassword })).status, 'pending')
      await assert.rejects(lifecycle.redeemPasswordAction(anonymous, { token: pending.activationToken, newPassword: initialPassword }), isCode('INVALID_ACTION'))
      const other = await bootstrapInitialAdmin({ pool, passwordHasher: hasher, deploymentId: randomUUID(),
        username: 'other.admin', displayName: 'Other', password: adminPassword })
      await assert.rejects(lifecycle.setAccountEnabled(operatorRequest, { userId: other.userId, enabled: false, adminPassword }), isCode('NOT_FOUND'))
      assert.equal((await user(other.userId)).status, 'active')
    })

    await t.test('expired and foreign-deployment action tokens cannot change passwords', async () => {
      const pending = await create('expiring.user')
      await pool.query("UPDATE dyoffice_password_action_tokens SET created_at=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hashToken(pending.activationToken)])
      await assert.rejects(lifecycle.redeemPasswordAction(anonymous, { token: pending.activationToken, newPassword: initialPassword }), isCode('INVALID_ACTION'))
      const foreign = createAccountLifecycle({ ...dependencies, deploymentId: randomUUID() })
      const valid = await create('private.user')
      await assert.rejects(foreign.redeemPasswordAction(anonymous, { token: valid.activationToken, newPassword: initialPassword }), isCode('INVALID_ACTION'))
      assert.equal((await user(valid.userId)).password_hash, null)
    })

    await t.test('duplicate normalized account creation rolls back workspace, token and audit inserts', async () => {
      const before = (await rows('SELECT count(*) AS n FROM dyoffice_account_events'))[0].n
      await assert.rejects(create('ALICE.LOCAL'), isCode('CONFLICT'))
      assert.equal((await rows('SELECT count(*) AS n FROM dyoffice_account_events'))[0].n, before)
      assert.equal((await rows("SELECT id FROM dyoffice_users WHERE deployment_id=$1 AND username_normalized='alice.local'", [deploymentId])).length, 1)
    })

    await t.test('audit storage failure rolls back the credential change and token consumption', async () => {
      const pending = await create('audit.user')
      await pool.query(`CREATE FUNCTION reject_account_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$`)
      await pool.query('CREATE TRIGGER reject_account_event BEFORE INSERT ON dyoffice_account_events FOR EACH ROW EXECUTE FUNCTION reject_account_event()')
      try {
        await assert.rejects(lifecycle.redeemPasswordAction(anonymous, { token: pending.activationToken, newPassword: initialPassword }), isCode('UNAVAILABLE'))
        assert.equal((await user(pending.userId)).status, 'pending')
        assert.equal((await rows('SELECT consumed_at FROM dyoffice_password_action_tokens WHERE token_hash=$1', [hashToken(pending.activationToken)]))[0].consumed_at, null)
      } finally { await pool.query('DROP TRIGGER reject_account_event ON dyoffice_account_events') }
      await lifecycle.redeemPasswordAction(anonymous, { token: pending.activationToken, newPassword: initialPassword })
      assert.equal((await user(pending.userId)).status, 'active')
    })

    await t.test('role change and user list stay inside the account and omit file or password data', async () => {
      const listed = await lifecycle.listUsers(operatorRequest, { limit: 50 })
      assert.ok(listed.users.some(row => row.userId === alice.userId && row.roles.includes('user') && !row.roles.includes('config_admin')))
      assert.equal(JSON.stringify(listed).includes('argon2'), false)
      assert.equal(JSON.stringify(listed).includes('password'), false)
      const prior = await sessions.issue({ deploymentId, userId: alice.userId })
      const changed = await lifecycle.setRoles(operatorRequest, { userId: alice.userId, roles: ['auditor', 'user'], adminPassword })
      assert.deepEqual(changed.roles, ['auditor', 'user'])
      assert.deepEqual((await rows('SELECT role FROM dyoffice_user_roles WHERE user_id=$1 ORDER BY role', [alice.userId])).map(row => row.role), ['auditor', 'user'])
      assert.ok((await rows("SELECT action FROM dyoffice_account_events WHERE target_user_id=$1 AND action='account.role_changed'", [alice.userId])).length >= 1)
      assert.equal(await sessions.authenticate(req(prior), { deploymentId }), null)
      assert.ok(await sessions.issue({ deploymentId, userId: alice.userId }))
    })

    await t.test('administrator version changes after Argon2 verification are rejected inside the mutation transaction', async () => {
      const raced = createAccountLifecycle({ ...dependencies, passwordHasher: {
        hashPassword: value => hasher.hashPassword(value),
        async verifyPassword(hash, password) {
          const valid = await hasher.verifyPassword(hash, password)
          if (valid) await pool.query('UPDATE dyoffice_users SET auth_version=auth_version+1 WHERE id=$1', [admin.userId])
          return valid
        },
      } })
      await assert.rejects(raced.createAccount(operatorRequest, { username: 'race.user', displayName: 'Race', adminPassword }), isCode('REAUTHENTICATION_REQUIRED'))
      assert.equal((await rows("SELECT id FROM dyoffice_users WHERE username_normalized='race.user'")).length, 0)
    })

    await t.test('account audit records contain only typed event metadata, never password or token strings', async () => {
      const audit = await rows('SELECT * FROM dyoffice_account_events')
      assert.ok(audit.some(e => e.action === 'account.created'))
      assert.ok(audit.some(e => e.action === 'password.activated'))
      assert.ok(audit.some(e => e.action === 'password.reset'))
      assert.ok(audit.some(e => e.action === 'account.disabled'))
      const serialized = JSON.stringify(audit)
      for (const secret of [adminPassword, initialPassword, replacementPassword, alice.activationToken]) {
        assert.equal(serialized.includes(secret), false)
      }
      assert.deepEqual(Object.keys(audit[0]).sort(), ['id','deployment_id','actor_user_id','target_user_id','action','created_at'].sort())
    })
  } finally {
    if (pool) await pool.end()
    try { await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await root.end() }
  }
})
