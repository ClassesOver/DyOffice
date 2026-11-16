import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { applyMigrations } from '../../server/db/migrate.mjs'
import { bootstrapInitialAdmin } from '../../server/auth/bootstrap-admin.mjs'
import { createPasswordHasher } from '../../server/auth/passwords.mjs'
import { createSessionService } from '../../server/auth/session-core.mjs'
import { createCsrfPolicy } from '../../server/auth/csrf-policy.mjs'
import { createPgLoginThrottle } from '../../server/auth/login-throttle.mjs'
import { createLocalLoginService } from '../../server/auth/login-service.mjs'
import { createLocalAuthHttpAdapter } from '../../server/auth/http-auth-adapter.mjs'
import { createAccountLifecycle } from '../../server/auth/account-lifecycle.mjs'
import { createPasswordChangeService } from '../../server/auth/password-change.mjs'
import { createPasswordChangeHttpAdapter } from '../../server/auth/password-change-http.mjs'

const connectionString = process.env.DYOFFICE_TEST_DATABASE_URL
if (!connectionString) throw new Error('Disposable PostgreSQL connection required')
const origin = 'https://office.example.test'
const adminPassword = 'The administrator owns this passphrase 2026!'
const oldPassword = 'The ordinary user owns this passphrase 2026!'
const newPassword = 'The ordinary user changes to this passphrase 2027!'
const otherPassword = 'Another fresh private user passphrase 2028!'
const errorCode = expected => e => e?.code === expected

test('real HTTP password change rotates sessions and is atomic under PostgreSQL races', { timeout: 120000 }, async t => {
  const schema = 'change_' + randomBytes(8).toString('hex')
  const root = new pg.Pool({ connectionString, max: 2 })
  let pool, server
  try {
    await root.query(`CREATE SCHEMA "${schema}"`)
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public`, statement_timeout: 20000 })
    assert.deepEqual(await applyMigrations(pool), ['0001_identity.sql','0002_login_rate_limits.sql',
      '0003_account_lifecycle_audit.sql','0004_self_password_change.sql'])
    assert.deepEqual(await applyMigrations(pool), [])
    const deploymentId = randomUUID()
    const hasher = createPasswordHasher({ maxConcurrent: 4 })
    const admin = await bootstrapInitialAdmin({ pool, passwordHasher: hasher, deploymentId,
      username: 'operator.admin', displayName: 'Operator', password: adminPassword })
    const sessions = createSessionService({ pool })
    const csrf = createCsrfPolicy({ secret: randomBytes(32), trustedOrigin: origin })
    const throttle = createPgLoginThrottle({ pool, hmacKey: randomBytes(32), limits: {
      global: { maxAttempts: 1000, windowMs: 60000 }, ip: { maxAttempts: 500, windowMs: 60000 },
      account: { maxAttempts: 200, windowMs: 60000 },
    } })
    const dependencies = { pool, passwordHasher: hasher, sessionService: sessions, csrfPolicy: csrf, throttle, deploymentId }
    const lifecycle = createAccountLifecycle(dependencies)
    const service = createPasswordChangeService(dependencies)
    const login = await createLocalLoginService(dependencies)
    const loginHttp = createLocalAuthHttpAdapter({ loginService: login, sessionService: sessions,
      csrfPolicy: csrf, deploymentId, trustedOrigin: origin })
    const changeHttp = createPasswordChangeHttpAdapter({ service, trustedOrigin: origin })
    server = createServer(async (req, res) => {
      if (!await changeHttp(req, res) && !await loginHttp(req, res)) { res.writeHead(404); res.end() }
    })
    server.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const rows = async (sql, values = []) => (await pool.query(sql, values)).rows
    const user = async id => (await rows('SELECT * FROM dyoffice_users WHERE id=$1', [id]))[0]
    const operatorSession = await sessions.issue({ deploymentId, userId: admin.userId })
    function request(session) {
      const cookie = session.cookie.split(';')[0]
      const token = csrf.issue({ sessionId: session.sessionId, deploymentId })
      return { headers: { cookie, origin, 'x-dyoffice-csrf': token },
        rawHeaders: ['Cookie', cookie, 'Origin', origin, 'X-DyOffice-CSRF', token], socket: { remoteAddress: '127.0.0.1' } }
    }
    const operatorRequest = request(operatorSession)
    const anonymous = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    async function ordinary(name) {
      const pending = await lifecycle.createAccount(operatorRequest, { username: name, displayName: name, adminPassword })
      await lifecycle.redeemPasswordAction(anonymous, { token: pending.activationToken, newPassword: oldPassword })
      const session = await sessions.issue({ deploymentId, userId: pending.userId })
      return { userId: pending.userId, session, request: request(session) }
    }
    const httpLogin = (username, password) => fetch(base + '/api/v1/auth/login', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })

    await t.test('HTTP login -> self change -> old-session denial -> fresh session and new-password login', async () => {
      const alice = await ordinary('alice.local')
      const logged = await httpLogin('alice.local', oldPassword)
      assert.equal(logged.status, 200)
      const cookie = logged.headers.get('set-cookie').split(';')[0]
      await logged.json()
      const csrfResponse = await fetch(base + '/api/v1/auth/csrf', { headers: { Cookie: cookie } })
      const csrfToken = (await csrfResponse.json()).csrfToken
      const second = alice.session
      const pendingActionId = randomUUID()
      await pool.query(`INSERT INTO dyoffice_password_action_tokens
        (id,deployment_id,user_id,purpose,token_hash,expires_at,issued_by)
        VALUES ($1,$2,$3,'reset',$4,clock_timestamp()+interval '15 minutes',$5)`,
      [pendingActionId, deploymentId, alice.userId, randomBytes(32), admin.userId])
      const changed = await fetch(base + '/api/v1/auth/change-password', { method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'X-DyOffice-CSRF': csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: oldPassword, newPassword }) })
      assert.equal(changed.status, 200)
      assert.deepEqual(await changed.json(), { ok: true })
      const nextCookie = changed.headers.get('set-cookie').split(';')[0]
      assert.notEqual(nextCookie, cookie)
      assert.equal((await fetch(base + '/api/v1/auth/me', { headers: { Cookie: cookie } })).status, 401)
      const me = await fetch(base + '/api/v1/auth/me', { headers: { Cookie: nextCookie } })
      assert.equal(me.status, 200); assert.equal((await me.json()).userId, alice.userId)
      assert.equal(await sessions.authenticate(request(second), { deploymentId }), null)
      assert.ok(await sessions.authenticate(operatorRequest, { deploymentId }), 'unrelated admin session survives')
      assert.ok((await rows('SELECT revoked_at FROM dyoffice_password_action_tokens WHERE id=$1', [pendingActionId]))[0].revoked_at)
      assert.equal(await hasher.verifyPassword((await user(alice.userId)).password_hash, newPassword), true)
      assert.equal((await httpLogin('alice.local', oldPassword)).status, 401)
      assert.equal((await httpLogin('alice.local', newPassword)).status, 200)
      const renewedCsrf = await fetch(base + '/api/v1/auth/csrf', { headers: { Cookie: nextCookie } })
      assert.notEqual((await renewedCsrf.json()).csrfToken, csrfToken)
    })

    await t.test('wrong password, cross-user injection, missing CSRF and disabled state cannot mutate credentials', async () => {
      const bob = await ordinary('bob.local')
      const initial = await user(bob.userId)
      await assert.rejects(service.changePassword(bob.request, { currentPassword: 'incorrect', newPassword }), errorCode('INVALID_CREDENTIALS'))
      await assert.rejects(service.changePassword(bob.request, { currentPassword: oldPassword, newPassword, userId: admin.userId }), errorCode('INVALID_INPUT'))
      const noCsrf = { ...bob.request, headers: { cookie: bob.request.headers.cookie } }
      await assert.rejects(service.changePassword(noCsrf, { currentPassword: oldPassword, newPassword }), errorCode('FORBIDDEN'))
      assert.equal((await user(bob.userId)).password_hash, initial.password_hash)
      await lifecycle.setAccountEnabled(operatorRequest, { userId: bob.userId, enabled: false, adminPassword })
      await assert.rejects(service.changePassword(bob.request, { currentPassword: oldPassword, newPassword }), errorCode('UNAUTHORIZED'))
      const foreign = createPasswordChangeService({ ...dependencies, deploymentId: randomUUID() })
      await assert.rejects(foreign.changePassword(operatorRequest, { currentPassword: adminPassword, newPassword }), errorCode('UNAUTHORIZED'))
    })

    await t.test('concurrent old-password changes have one winner and one replacement session', async () => {
      const race = await ordinary('race.local')
      const starting = await user(race.userId)
      let count = 0, unblock
      const bothHashing = new Promise(resolve => { unblock = resolve })
      const racing = createPasswordChangeService({ ...dependencies, passwordHasher: {
        verifyPassword: (hash, value) => hasher.verifyPassword(hash, value),
        async hashPassword(value) {
          const result = await hasher.hashPassword(value)
          if (++count === 2) unblock()
          await bothHashing
          return result
        },
      } })
      const passwords = [newPassword, otherPassword]
      const results = await Promise.allSettled(passwords.map(value => racing.changePassword(race.request,
        { currentPassword: oldPassword, newPassword: value })))
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'AUTHENTICATION_CHANGED').length, 1)
      const winner = results.findIndex(r => r.status === 'fulfilled')
      const saved = await user(race.userId)
      assert.equal(BigInt(saved.auth_version), BigInt(starting.auth_version) + 1n)
      assert.equal(await hasher.verifyPassword(saved.password_hash, passwords[winner]), true)
      assert.equal((await rows('SELECT id FROM dyoffice_sessions WHERE user_id=$1 AND revoked_at IS NULL', [race.userId])).length, 1)
      assert.equal((await rows("SELECT id FROM dyoffice_account_events WHERE target_user_id=$1 AND action='password.changed'", [race.userId])).length, 1)
    })

    await t.test('admin reset during hashing cannot be overwritten by a stale self-service change', async () => {
      const race = await ordinary('reset.race')
      let reset
      const racing = createPasswordChangeService({ ...dependencies, passwordHasher: {
        verifyPassword: (hash, value) => hasher.verifyPassword(hash, value),
        async hashPassword(value) {
          const result = await hasher.hashPassword(value)
          reset = await lifecycle.issuePasswordReset(operatorRequest, { userId: race.userId, adminPassword })
          return result
        },
      } })
      await assert.rejects(racing.changePassword(race.request, { currentPassword: oldPassword, newPassword }), errorCode('AUTHENTICATION_CHANGED'))
      const after = await user(race.userId)
      assert.equal(after.status, 'pending'); assert.equal(after.password_hash, null)
      await lifecycle.redeemPasswordAction(anonymous, { token: reset.resetToken, newPassword: otherPassword })
      assert.equal(await hasher.verifyPassword((await user(race.userId)).password_hash, otherPassword), true)
    })

    await t.test('audit or session-insert failure rolls back password/version/revocations and leaves the original login valid', async () => {
      const person = await ordinary('rollback.user')
      const original = await user(person.userId)
      for (const table of ['dyoffice_account_events', 'dyoffice_sessions']) {
        await pool.query(`CREATE OR REPLACE FUNCTION refuse_password_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected failure'; END $$`)
        await pool.query(`CREATE TRIGGER refuse_password_change BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_password_change()`)
        try {
          await assert.rejects(service.changePassword(person.request, { currentPassword: oldPassword, newPassword }), errorCode('UNAVAILABLE'))
          const restored = await user(person.userId)
          assert.equal(restored.password_hash, original.password_hash)
          assert.equal(restored.auth_version, original.auth_version)
          assert.ok(await sessions.authenticate(person.request, { deploymentId }))
          assert.equal((await rows("SELECT id FROM dyoffice_account_events WHERE target_user_id=$1 AND action='password.changed'", [person.userId])).length, 0)
        } finally { await pool.query(`DROP TRIGGER refuse_password_change ON ${table}`) }
      }
    })

    await t.test('self-change audit has no passwords, cookie values or arbitrary client metadata', async () => {
      const events = await rows("SELECT * FROM dyoffice_account_events WHERE action='password.changed'")
      assert.ok(events.length > 0)
      for (const event of events) assert.equal(event.actor_user_id, event.target_user_id)
      const json = JSON.stringify(events)
      for (const secret of [oldPassword, newPassword, otherPassword, operatorSession.cookie]) assert.equal(json.includes(secret), false)
    })
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (pool) await pool.end()
    try { await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await root.end() }
  }
})
