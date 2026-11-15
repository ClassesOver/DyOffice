import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { identityFixture, password } from '../helpers/identity.mjs'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'
import { buildLocalApp } from '../../server/src/app.ts'

const origin = 'https://office.example'
const sessionCookie = token => `__Host-dyoffice-session=${token}`
const headerCookie = response => response.headers['set-cookie'].map(x => x.split(';')[0]).join('; ')
async function fixture(t, options = {}) {
  const f = await identityFixture(t)
  const app = await buildLocalApp({ db: f.db, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: randomBytes(32).toString('hex'), ...options })
  f.cleanup.push(() => app.close())
  const sessions = createSessionService({ db: f.db, accounts: f.accounts, deploymentId: f.deploymentId })
  const challenge = async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' })
    assert.equal(response.statusCode, 200)
    return { cookie: headerCookie(response), csrf: response.json().csrfToken }
  }
  const login = async (username = 'owner', candidate = password) => {
    const c = await challenge()
    return app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { username, password: candidate } })
  }
  return { ...f, app, sessions, challenge, login }
}

test('login mints server-owned Secure cookies and stores only hashes; me reflects database roles', async t => {
  const { app, login, pool, deploymentId, user } = await fixture(t)
  const first = await login()
  assert.equal(first.statusCode, 200)
  const raw = first.headers['set-cookie'].find(x => x.startsWith('__Host-dyoffice-session='))
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(raw.includes(part))
  assert.equal(raw.includes('Domain='), false)
  const cookie = raw.split(';')[0]
  const token = cookie.split('=')[1]
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(JSON.stringify(first.json()).includes(token), false)
  const rows = (await pool.query('SELECT token_hash FROM sessions WHERE deployment_id=$1', [deploymentId])).rows
  assert.deepEqual(rows, [{ token_hash: createHash('sha256').update(token).digest('hex') }])
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.id, user.id)
  assert.deepEqual(me.json().user.roles, ['config_admin', 'personal'])
  assert.equal(JSON.stringify(me.json()).includes('password'), false)
  assert.equal(me.headers['cache-control'], 'no-store')
  const second = await login()
  assert.equal(second.statusCode, 200)
  assert.notEqual(headerCookie(second), cookie)
  assert.equal((await pool.query('SELECT id FROM sessions WHERE deployment_id=$1', [deploymentId])).rowCount, 2)
})

test('login rejects cross-origin, absent/replayed CSRF, identity injection and generic bad credentials', async t => {
  const { app, challenge, login, pool, deploymentId, user } = await fixture(t)
  for (const headers of [{}, { origin: 'https://other.example' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
    const c = await challenge()
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, ...headers }, payload: { username: 'owner', password } })
    assert.equal(response.statusCode, 403)
  }
  const c = await challenge()
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, cookie: c.cookie }, payload: { username: 'owner', password } })).statusCode, 403)
  const request = { method: 'POST', url: '/api/v1/auth/login', headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { username: 'owner', password: 'incorrect password phrase' } }
  assert.equal((await app.inject(request)).statusCode, 401)
  assert.equal((await app.inject(request)).statusCode, 403)
  const injected = await challenge()
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, cookie: injected.cookie, 'x-csrf-token': injected.csrf }, payload: { username: 'owner', password, role: 'config_admin', userId: user.id } })).statusCode, 400)
  const wrong = await login('owner', 'incorrect password phrase')
  const missing = await login('nonexistent', password)
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [user.id])
  const disabled = await login()
  for (const response of [wrong, missing, disabled]) {
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, wrong.json().error)
    assert.equal(JSON.stringify(response.json()).includes('owner'), false)
  }
  assert.equal((await pool.query('SELECT * FROM sessions WHERE deployment_id=$1', [deploymentId])).rowCount, 0)
})

test('local mode rejects development Bearer credentials and never exposes the shared prototype store', async t => {
  const { app, login } = await fixture(t)
  const loginResponse = await login()
  const cookie = headerCookie(loginResponse).split('; ')[0]
  for (const url of ['/api/preferences', '/api/files', '/api/admin/config', '/api/v1/files/guessed']) {
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer personal-secret' } })).statusCode, 401)
    const result = await app.inject({ method: 'GET', url, headers: { cookie } })
    assert.equal(result.statusCode, 501)
    assert.equal(result.json().status, 501)
  }
  const health = await app.inject({ method: 'GET', url: '/api/v1/health/ready' })
  assert.equal(health.statusCode, 200)
})

test('ambiguous Cookie headers and duplicate session cookies never choose the first credential', async t => {
  const { app, login } = await fixture(t)
  const response = await login()
  const cookie = headerCookie(response).split('; ')[0]
  const duplicate = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${cookie}; ${cookie}` } })
  assert.equal(duplicate.statusCode, 401)
  const { request } = await import('node:http')
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const status = await new Promise((resolve, reject) => {
    const req = request(address + '/api/v1/auth/me', { headers: { Cookie: [cookie, cookie] } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject); req.end()
  })
  assert.equal(status, 401)
})

test('logout and self-session revocation invalidate server state and retain CSRF protection', async t => {
  const { app, login, pool, deploymentId } = await fixture(t)
  const response = await login()
  const cookie = headerCookie(response).split('; ')[0]
  const csrf = response.json().csrfToken
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 200)
  const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin, 'x-csrf-token': csrf } })
  assert.equal(logout.statusCode, 204)
  assert.ok(logout.headers['set-cookie'].some(value => value.includes('Max-Age=0')))
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 401)
  assert.equal((await pool.query('SELECT * FROM sessions WHERE deployment_id=$1 AND revoked_at IS NOT NULL', [deploymentId])).rowCount, 1)
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin, 'x-csrf-token': csrf } })).statusCode, 204)
  const signed = await login()
  const nextCookie = headerCookie(signed).split('; ')[0]
  const listed = (await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie: nextCookie } })).json()
  const current = listed.sessions.find(row => row.current)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/auth/sessions/' + current.id, headers: { cookie: nextCookie, origin, 'x-csrf-token': signed.json().csrfToken } })).statusCode, 204)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: nextCookie } })).statusCode, 401)
})

test('session ownership and reauthentication rotate tokens without exposing other users', async t => {
  const { app, login, pool, deploymentId, passwords } = await fixture(t)
  const response = await login()
  const cookie = headerCookie(response).split('; ')[0]
  const csrf = response.json().csrfToken
  const otherUser = randomUUID(), otherSession = randomUUID()
  await pool.query("INSERT INTO users(id,deployment_id,username_normalized,password_hash,status) VALUES($1,$2,'other',$3,'active')", [otherUser, deploymentId, await passwords.hash(password)])
  await pool.query("INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,1,now()+interval '1 hour')", [otherSession, deploymentId, otherUser, createHash('sha256').update('other').digest('hex')])
  const list = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie } })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().sessions.length, 1)
  assert.equal(JSON.stringify(list.json()).includes(otherSession), false)
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/auth/sessions/' + otherSession, headers: { cookie, origin, 'x-csrf-token': csrf } })).statusCode, 404)
  const reauth = await app.inject({ method: 'POST', url: '/api/v1/auth/reauth', headers: { cookie, origin, 'x-csrf-token': csrf }, payload: { password } })
  assert.equal(reauth.statusCode, 200)
  const rotated = headerCookie(reauth).split('; ')[0]
  assert.notEqual(rotated, cookie)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: rotated } })).statusCode, 200)
})

test('idle expiry, absolute expiry, disabled accounts and auth-version changes reject old sessions', async t => {
  const { sessions, pool, user } = await fixture(t)
  for (const mutation of ["last_seen_at=now()-interval '9 hours'", "created_at=now()-interval '2 days', expires_at=now()-interval '1 day'"]) {
    const signed = await sessions.login('owner', password)
    await pool.query('UPDATE sessions SET ' + mutation + ' WHERE id=$1', [signed.sessionId])
    await assert.rejects(() => sessions.authenticate(signed.token), { statusCode: 401 })
  }
  const signed = await sessions.login('owner', password)
  await pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [user.id])
  await assert.rejects(() => sessions.authenticate(signed.token), { statusCode: 401 })
  const next = await sessions.login('owner', password)
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [user.id])
  await assert.rejects(() => sessions.authenticate(next.token), { statusCode: 401 })
})

test('login throttles count by normalized account across clients and by IP across accounts', async t => {
  const { app, challenge } = await fixture(t, { loginLimits: { accountMax: 2, ipMax: 3, globalMax: 20, windowMs: 60_000 } })
  const attempt = async (username, ip) => {
    const c = await challenge()
    return app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { username, password: 'incorrect password phrase' } })
  }
  assert.equal((await attempt('OWNER', '192.0.2.1')).statusCode, 401)
  assert.equal((await attempt(' owner ', '192.0.2.2')).statusCode, 401)
  const limited = await attempt('owner', '192.0.2.3')
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  for (const username of ['missing1', 'missing2', 'missing3']) assert.equal((await attempt(username, '192.0.2.4')).statusCode, 401)
  assert.equal((await attempt('missing4', '192.0.2.4')).statusCode, 429)
})

test('production refuses local mode until restricted runtime/RLS gates are implemented', async t => {
  const { db, passwords, deploymentId } = await identityFixture(t)
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try { await assert.rejects(() => buildLocalApp({ db, passwords, deploymentId, origin, csrfKey: randomBytes(32).toString('hex') }), /production/i) }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous }
})

async function waitForAuthorityLock(pool) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [pool.options.application_name])
    if (waiting.rowCount) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Expected authority lock wait did not occur')
}

test('a disable committed during password verification prevents the waiting login from minting a session', async t => {
  const { sessions, pool, user, deploymentId } = await fixture(t)
  const blocker = await pool.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id])
    const outcome = sessions.login('owner', password).then(() => null, error => error)
    await waitForAuthorityLock(pool)
    await blocker.query("UPDATE users SET status='disabled',auth_version=auth_version+1 WHERE id=$1", [user.id])
    await blocker.query('COMMIT')
    assert.equal((await outcome)?.statusCode, 401)
    assert.equal((await pool.query('SELECT * FROM sessions WHERE deployment_id=$1', [deploymentId])).rowCount, 0)
  } finally { await blocker.query('ROLLBACK'); blocker.release() }
})

test('a session revoke committed before a waiting lookup is rechecked after the credential lock', async t => {
  const { sessions, pool, user } = await fixture(t)
  const signed = await sessions.login('owner', password)
  const blocker = await pool.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [user.id])
    await blocker.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [signed.sessionId])
    const outcome = sessions.authenticate(signed.token).then(() => null, error => error)
    await waitForAuthorityLock(pool)
    await blocker.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [signed.sessionId])
    await blocker.query('COMMIT')
    assert.equal((await outcome)?.statusCode, 401)
  } finally { await blocker.query('ROLLBACK'); blocker.release() }
})

test('a login challenge has one winner under concurrent reuse and an expired challenge is rejected', async t => {
  const { app, challenge, pool, deploymentId } = await fixture(t)
  const c = await challenge()
  const request = { method: 'POST', url: '/api/v1/auth/login', headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { username: 'owner', password } }
  const outcomes = await Promise.all([app.inject(request), app.inject(request)])
  assert.deepEqual(outcomes.map(x => x.statusCode).sort(), [200, 403])
  const expired = await challenge()
  await pool.query("UPDATE login_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE deployment_id=$1", [deploymentId])
  assert.equal((await app.inject({ ...request, headers: { origin, cookie: expired.cookie, 'x-csrf-token': expired.csrf } })).statusCode, 403)
})

test('repeated login bursts increase cooldown after the first block expires', async t => {
  const { app, challenge, pool, deploymentId } = await fixture(t, { loginLimits: { accountMax: 1, ipMax: 100, globalMax: 100, windowMs: 1000 } })
  const attempt = async () => {
    const c = await challenge()
    return app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { username: 'owner', password: 'incorrect password phrase' } })
  }
  assert.equal((await attempt()).statusCode, 401)
  assert.equal((await attempt()).headers['retry-after'], '1')
  await pool.query("UPDATE login_throttles SET blocked_until=clock_timestamp()-interval '1 millisecond',window_started_at=clock_timestamp()-interval '2 seconds' WHERE deployment_id=$1 AND kind='account'", [deploymentId])
  assert.equal((await attempt()).statusCode, 401)
  const second = await attempt()
  assert.equal(second.statusCode, 429)
  assert.ok(Number(second.headers['retry-after']) >= 2)
})

test('server startup selects local mode without creating prototype data or accepting development tokens', { timeout: 10_000 }, async t => {
  const { cleanup, deploymentId } = await identityFixture(t)
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { fileURLToPath } = await import('node:url')
  const { mkdtemp, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-local-start-'))
  const data = join(directory, 'prototype-must-not-exist')
  const env = { ...process.env, NODE_ENV: 'development', DYOFFICE_AUTH_MODE: 'local', DYOFFICE_DATABASE_URL: process.env.DYOFFICE_TEST_DATABASE_URL, DYOFFICE_DEPLOYMENT_ID: deploymentId, DYOFFICE_ORIGIN: origin, DYOFFICE_CSRF_KEY: randomBytes(32).toString('hex'), DYOFFICE_DATA_DIR: data, DYOFFICE_USER_TOKEN: '', DYOFFICE_ADMIN_TOKEN: '', HOST: '127.0.0.1', PORT: '0' }
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    await rm(directory, { recursive: true, force: true })
  })
  const exit = once(child, 'exit')
  const [chunk] = await Promise.race([once(child.stdout, 'data'), exit.then(([code]) => { throw new Error('Startup exited with code ' + code) })])
  const address = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(address)
  assert.equal((await fetch(address + '/api/v1/health/ready')).status, 200)
  assert.equal((await fetch(address + '/api/preferences', { headers: { authorization: 'Bearer personal-secret' } })).status, 401)
  await assert.rejects(() => stat(data), { code: 'ENOENT' })
  child.kill('SIGTERM')
  assert.deepEqual(await exit, [0, null])
})

test('global login budget is shared across different account and peer-IP buckets', async t => {
  const { app, challenge } = await fixture(t, { loginLimits: { accountMax: 20, ipMax: 20, globalMax: 2, windowMs: 60_000 } })
  const results = []
  for (let i = 0; i < 3; i++) {
    const c = await challenge()
    results.push((await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: `192.0.2.${i + 1}`, headers: { origin, cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { username: 'missing' + i, password } })).statusCode)
  }
  assert.deepEqual(results, [401, 401, 429])
})

test('an IP already blocked by narrower policy cannot consume the global password-work budget', async t => {
  const { db, deploymentId } = await identityFixture(t)
  const { createLoginThrottle } = await import('../../server/src/modules/auth/throttle.ts')
  const throttle = createLoginThrottle(db, deploymentId, randomBytes(32).toString('hex'), { accountMax: 100, ipMax: 2, globalMax: 4 })
  await throttle.reserve('missing0', '192.0.2.1')
  await throttle.reserve('missing1', '192.0.2.1')
  for (let i = 2; i < 12; i++) await assert.rejects(() => throttle.reserve('missing' + i, '192.0.2.1'), { statusCode: 429 })
  await assert.doesNotReject(() => throttle.reserve('owner', '192.0.2.2'))
})

test('blocked requests do not allocate new account buckets and expiry preserves active cooldowns', async t => {
  const { db, pool, deploymentId } = await identityFixture(t)
  const { createLoginThrottle } = await import('../../server/src/modules/auth/throttle.ts')
  const throttle = createLoginThrottle(db, deploymentId, randomBytes(32).toString('hex'), { accountMax: 100, ipMax: 1, globalMax: 100 })
  await throttle.reserve('missing0', '192.0.2.1')
  for (let i = 1; i < 10; i++) await assert.rejects(() => throttle.reserve('missing' + i, '192.0.2.1'), { statusCode: 429 })
  const count = await pool.query("SELECT count(*)::int AS count FROM login_throttles WHERE deployment_id=$1 AND kind='account'", [deploymentId])
  assert.equal(count.rows[0].count, 1)
  const expired = randomBytes(32).toString('hex'), active = randomBytes(32).toString('hex')
  await pool.query("INSERT INTO login_throttles(deployment_id,kind,key_hash,window_started_at,blocked_until) VALUES($1,'account',$2,clock_timestamp()-interval '2 hours',NULL),($1,'account',$3,clock_timestamp()-interval '2 hours',clock_timestamp()+interval '1 hour')", [deploymentId, expired, active])
  await throttle.reserve('owner', '192.0.2.2')
  const retained = (await pool.query('SELECT key_hash FROM login_throttles WHERE deployment_id=$1 AND key_hash=ANY($2::text[])', [deploymentId, [expired, active]])).rows
  assert.deepEqual(retained, [{ key_hash: active }])
})

test('auth security events correlate server request IDs and target sessions without credentials', async t => {
  const { app, login, pool, deploymentId } = await fixture(t)
  const failed = await login('missing-owner', password)
  const requestId = failed.headers['x-request-id']
  const failedRows = (await pool.query("SELECT request_id,account_key FROM auth_security_events WHERE deployment_id=$1 AND event='login_failed'", [deploymentId])).rows
  assert.equal(failedRows.length, 1)
  assert.equal(failedRows[0].request_id, requestId)
  assert.match(failedRows[0].account_key, /^[a-f0-9]{64}$/)
  const signed = await login()
  const cookie = headerCookie(signed).split('; ')[0]
  const listed = (await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie } })).json()
  const target = listed.sessions.find(row => row.current).id
  const revoked = await app.inject({ method: 'DELETE', url: '/api/v1/auth/sessions/' + target, headers: { cookie, origin, 'x-csrf-token': signed.json().csrfToken } })
  const event = (await pool.query("SELECT * FROM auth_security_events WHERE deployment_id=$1 AND event='session_revoked'", [deploymentId])).rows[0]
  assert.equal(event.request_id, revoked.headers['x-request-id'])
  assert.equal(event.session_id, target)
  assert.equal(JSON.stringify(event).includes(password), false)
  assert.equal(JSON.stringify(event).includes(cookie.split('=')[1]), false)
})

test('local runtime refuses a deployment that has not completed explicit administrator bootstrap', async t => {
  const { db, passwords } = await identityFixture(t)
  let unexpected
  try {
    await assert.rejects(async () => {
      unexpected = await buildLocalApp({ db, passwords, deploymentId: randomUUID(), origin, csrfKey: randomBytes(32).toString('hex') })
    }, /bootstrapped/)
  } finally { await unexpected?.close() }
})

test('an account already blocked across peers cannot consume the remaining global budget', async t => {
  const { db, deploymentId } = await identityFixture(t)
  const { createLoginThrottle } = await import('../../server/src/modules/auth/throttle.ts')
  const throttle = createLoginThrottle(db, deploymentId, randomBytes(32).toString('hex'), { accountMax: 1, ipMax: 100, globalMax: 2 })
  await throttle.reserve('blocked-account', '192.0.2.1')
  for (let i = 0; i < 5; i++) await assert.rejects(() => throttle.reserve('blocked-account', `192.0.2.${i + 2}`), { statusCode: 429 })
  await assert.doesNotReject(() => throttle.reserve('owner', '192.0.2.100'))
})
