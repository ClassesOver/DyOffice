import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { applyMigrations } from '../../server/db/migrate.mjs'
import { createPasswordHasher } from '../../server/auth/passwords.mjs'
import { bootstrapInitialAdmin } from '../../server/auth/bootstrap-admin.mjs'
import { createSessionService, CLEAR_SESSION_COOKIE } from '../../server/auth/session-core.mjs'
import { createCsrfPolicy } from '../../server/auth/csrf-policy.mjs'
import { createPgLoginThrottle } from '../../server/auth/login-throttle.mjs'
import { createLocalLoginService } from '../../server/auth/login-service.mjs'
import { createLocalAuthHttpAdapter } from '../../server/auth/http-auth-adapter.mjs'
import { createSelfSessionManagement } from '../../server/auth/self-session-management.mjs'
import { createSelfSessionHttpAdapter } from '../../server/auth/self-session-management-http.mjs'

const connectionString = process.env.DYOFFICE_TEST_DATABASE_URL
if (!connectionString) throw Error('Disposable PostgreSQL connection required')
const origin = 'https://office.example.test', password = 'Long varied test account passphrase 2026!'
const migrations = ['0001_identity.sql', '0002_login_rate_limits.sql', '0003_files.sql', '0004_revisions.sql',
  '0005_account_lifecycle_audit.sql', '0006_self_password_change.sql', '0007_session_security_events.sql', '0008_account_roles.sql']

test('real HTTP/PostgreSQL session management preserves owner and transaction boundaries', { timeout: 120_000 }, async t => {
  const schema = 'sessions_' + randomBytes(8).toString('hex')
  const root = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 })
  let pool, server
  try {
    await root.query(`CREATE SCHEMA "${schema}"`)
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public`,
      connectionTimeoutMillis: 5000, statement_timeout: 20000 })
    assert.deepEqual(await applyMigrations(pool), migrations)
    assert.deepEqual(await applyMigrations(pool), [])
    const deploymentId = randomUUID(), otherDeployment = randomUUID()
    const hasher = createPasswordHasher({ maxConcurrent: 4 })
    const admin = await bootstrapInitialAdmin({ pool, passwordHasher: hasher, deploymentId, username: 'operator.admin', displayName: 'Admin', password })
    const foreign = await bootstrapInitialAdmin({ pool, passwordHasher: hasher, deploymentId: otherDeployment, username: 'other.admin', displayName: 'Other', password })
    const userA = randomUUID(), userB = randomUUID(), hash = await hasher.hashPassword(password)
    for (const [id, username] of [[userA, 'alice.local'], [userB, 'bob.local']]) {
      await pool.query("INSERT INTO dyoffice_users (id,deployment_id,username_normalized,display_name,password_hash,status) VALUES ($1,$2,$3,$3,$4,'active')", [id, deploymentId, username, hash])
      await pool.query("INSERT INTO dyoffice_user_roles (deployment_id,user_id,role) VALUES ($1,$2,'user')", [deploymentId, id])
    }
    const sessions = createSessionService({ pool }), csrf = createCsrfPolicy({ secret: randomBytes(32), trustedOrigin: origin })
    const throttle = createPgLoginThrottle({ pool, hmacKey: randomBytes(32), limits: {
      global: { maxAttempts: 1000, windowMs: 60_000 }, ip: { maxAttempts: 500, windowMs: 60_000 }, account: { maxAttempts: 100, windowMs: 60_000 },
    } })
    const login = await createLocalLoginService({ pool, passwordHasher: hasher, sessionService: sessions, throttle, deploymentId })
    const auth = createLocalAuthHttpAdapter({ loginService: login, sessionService: sessions, csrfPolicy: csrf, deploymentId, trustedOrigin: origin })
    const dependencies = { pool, sessionService: sessions, csrfPolicy: csrf, deploymentId }
    const service = createSelfSessionManagement(dependencies)
    const handler = createSelfSessionHttpAdapter({ service, trustedOrigin: origin })
    server = createServer(async (req, res) => {
      try { if (!await handler(req, res) && !await auth(req, res)) { res.writeHead(404); res.end() } }
      catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const path = '/api/v1/auth/sessions'
    const rows = async (sql, args = []) => (await pool.query(sql, args)).rows
    const signIn = async username => {
      const response = await fetch(base + '/api/v1/auth/login', { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      assert.equal(response.status, 200)
      const cookie = response.headers.get('set-cookie').split(';')[0]
      const principal = await sessions.authenticate({ headers: { cookie } }, { deploymentId })
      const responseCsrf = await fetch(base + '/api/v1/auth/csrf', { headers: { Cookie: cookie } })
      assert.equal(responseCsrf.status, 200)
      return { cookie, sessionId: principal.sessionId, csrf: (await responseCsrf.json()).csrfToken }
    }
    const get = (session, suffix = '') => fetch(base + path + suffix, { headers: { Cookie: session.cookie } })
    const remove = (session, id) => fetch(base + path + '/' + id, { method: 'DELETE',
      headers: { Cookie: session.cookie, Origin: origin, 'X-DyOffice-CSRF': session.csrf } })
    const live = session => sessions.authenticate({ headers: { cookie: session.cookie } }, { deploymentId })
    let a = await signIn('alice.local')
    const a2 = await signIn('alice.local'), a3 = await signIn('alice.local'), b = await signIn('bob.local'), operator = await signIn('operator.admin')
    const foreignSession = await sessions.issue({ deploymentId: otherDeployment, userId: foreign.userId })

    await t.test('requires login and returns only own live sessions with stable bounded pagination', async () => {
      assert.equal((await fetch(base + path)).status, 401)
      const found = [], seen = new Set(); let cursor = null
      do {
        const response = await get(a, '?limit=2' + (cursor ? '&before=' + cursor : ''))
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
        const page = await response.json()
        for (const item of page.sessions) {
          assert.deepEqual(Object.keys(item).sort(), ['sessionId','createdAt','lastSeenAt','expiresAt','current'].sort())
          assert.equal(seen.has(item.sessionId), false); seen.add(item.sessionId); found.push(item)
        }
        cursor = page.nextCursor
        assert.ok(found.length <= 3)
      } while (cursor)
      assert.deepEqual([...seen].sort(), [a.sessionId,a2.sessionId,a3.sessionId].sort())
      assert.equal(found.find(s => s.current).sessionId, a.sessionId)
      const text = JSON.stringify(found)
      for (const secret of [password, hash, a.cookie, b.cookie]) assert.equal(text.includes(secret), false)
    })
    await t.test('unknown/foreign cursor and userId injection cannot read other identities', async () => {
      for (const id of [b.sessionId, foreignSession.sessionId, randomUUID()]) assert.equal((await get(a, '?before=' + id)).status, 400)
      assert.equal((await get(a, '?userId=' + userB)).status, 400)
      assert.deepEqual((await (await get(operator)).json()).sessions.map(x => x.sessionId), [operator.sessionId])
    })
    await t.test('foreign targets including Admin to personal user have the same 204 as missing targets', async () => {
      for (const [caller, target] of [[a,b.sessionId], [operator,a.sessionId], [a,foreignSession.sessionId], [a,randomUUID()]]) {
        const response = await remove(caller, target)
        assert.equal(response.status, 204); assert.equal(response.headers.get('set-cookie'), null); assert.equal(await response.text(), '')
      }
      assert.ok(await live(a)); assert.ok(await live(b))
      assert.equal((await rows('SELECT id FROM dyoffice_session_security_events')).length, 0)
    })
    await t.test('revokes one session exactly once and writes an owner-bound audit record', async () => {
      assert.equal((await remove(a, a2.sessionId)).status, 204)
      assert.equal(await live(a2), null)
      assert.equal((await remove(a, a2.sessionId)).status, 204)
      const audit = await rows('SELECT * FROM dyoffice_session_security_events WHERE target_session_id=$1', [a2.sessionId])
      assert.equal(audit.length, 1); assert.equal(audit[0].user_id, userA); assert.equal(audit[0].actor_session_id, a.sessionId)
      assert.equal(audit[0].affected_count, 1)
    })
    await t.test('CSRF denial does not revoke; revoke-others preserves current and other accounts', async () => {
      const missingCsrf = await fetch(base + path + '/revoke-others', { method: 'POST', headers: { Cookie: a.cookie, Origin: origin } })
      assert.equal(missingCsrf.status, 403); assert.ok(await live(a3))
      const response = await fetch(base + path + '/revoke-others', { method: 'POST',
        headers: { Cookie: a.cookie, Origin: origin, 'X-DyOffice-CSRF': a.csrf } })
      assert.equal(response.status, 204); assert.equal(response.headers.get('set-cookie'), null)
      assert.ok(await live(a)); assert.equal(await live(a3), null); assert.ok(await live(b))
      const audit = await rows("SELECT affected_count FROM dyoffice_session_security_events WHERE action='session.others_revoked'")
      assert.deepEqual(audit.map(r => r.affected_count), [1])
    })
    await t.test('current-session deletion clears Cookie only on success and rejects the old credential', async () => {
      const response = await remove(a, a.sessionId)
      assert.equal(response.status, 204); assert.equal(response.headers.get('set-cookie'), CLEAR_SESSION_COOKIE)
      assert.equal((await get(a)).status, 401)
      a = await signIn('alice.local') // revocation does not prohibit a future password login
      assert.equal((await get(a)).status, 200)
    })
    await t.test('expired, idle and wrong auth-version sessions are absent from the live list', async () => {
      const expired = await sessions.issue({ deploymentId, userId: userA }), idle = await sessions.issue({ deploymentId, userId: userA }), stale = await sessions.issue({ deploymentId, userId: userA })
      await pool.query("UPDATE dyoffice_sessions SET created_at=clock_timestamp()-interval '3 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.sessionId])
      await pool.query("UPDATE dyoffice_sessions SET last_seen_at=clock_timestamp()-interval '9 hours' WHERE id=$1", [idle.sessionId])
      await pool.query('UPDATE dyoffice_sessions SET auth_version=auth_version+1 WHERE id=$1', [stale.sessionId])
      assert.deepEqual((await (await get(a)).json()).sessions.map(s => s.sessionId), [a.sessionId])
    })
    await t.test('audit failure rolls back revocation and never clears Cookie', async () => {
      const target = await signIn('alice.local')
      await pool.query("CREATE FUNCTION reject_session_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$")
      await pool.query('CREATE TRIGGER reject_session_event BEFORE INSERT ON dyoffice_session_security_events FOR EACH ROW EXECUTE FUNCTION reject_session_event()')
      try {
        const response = await remove(a, target.sessionId)
        assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null)
        assert.equal((await response.text()).includes('Injected'), false)
        assert.ok(await live(target))
        assert.equal((await rows('SELECT id FROM dyoffice_session_security_events WHERE target_session_id=$1', [target.sessionId])).length, 0)
      } finally { await pool.query('DROP TRIGGER reject_session_event ON dyoffice_session_security_events') }
    })
    await t.test('concurrent duplicate revocation commits only one audit event', async () => {
      const target = await signIn('alice.local')
      const results = await Promise.all([remove(a, target.sessionId), remove(a, target.sessionId)])
      assert.deepEqual(results.map(r => r.status), [204,204])
      assert.equal((await rows('SELECT id FROM dyoffice_session_security_events WHERE target_session_id=$1', [target.sessionId])).length, 1)
      assert.equal(await live(target), null)
    })
    await t.test('database audit FK rejects a target session belonging to another owner', async () => {
      await assert.rejects(pool.query(`INSERT INTO dyoffice_session_security_events
        (id,deployment_id,user_id,actor_session_id,target_session_id,action,affected_count)
        VALUES ($1,$2,$3,$4,$5,'session.revoked',1)`, [randomUUID(), deploymentId, userA, a.sessionId, b.sessionId]), e => e.code === '23503')
      const audit = await rows('SELECT * FROM dyoffice_session_security_events')
      for (const event of audit) assert.deepEqual(Object.keys(event).sort(), ['id','deployment_id','user_id','actor_session_id','target_session_id','action','affected_count','created_at'].sort())
      for (const secret of [password, hash, a.cookie, b.cookie]) assert.equal(JSON.stringify(audit).includes(secret), false)
    })
    await t.test('a disable after initial authentication cannot revoke under a stale principal', async () => {
      const target = await signIn('alice.local')
      const raced = createSelfSessionManagement({ ...dependencies, sessionService: { async authenticate(request, options) {
        const principal = await sessions.authenticate(request, options)
        await pool.query("UPDATE dyoffice_users SET status='disabled',disabled_at=clock_timestamp(),auth_version=auth_version+1 WHERE id=$1", [userA])
        return principal
      } } })
      await assert.rejects(raced.revoke({ headers: { cookie: a.cookie, origin, 'x-dyoffice-csrf': a.csrf } }, { sessionId: target.sessionId }), e => e.code === 'UNAUTHORIZED')
      assert.equal((await rows('SELECT revoked_at FROM dyoffice_sessions WHERE id=$1', [target.sessionId]))[0].revoked_at, null)
      assert.equal((await get(a)).status, 401)
    })
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    if (pool) await pool.end()
    try { await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await root.end() }
  }
})
