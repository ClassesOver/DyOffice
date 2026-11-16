import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPasswordChangeService } from '../server/auth/password-change.mjs'

const deploymentId = randomUUID(), userId = randomUUID(), sessionId = randomUUID()
const currentPassword = 'My existing private passphrase 2026!'
const newPassword = 'My different private passphrase 2027!'
const phc = '$argon2id$v=19$m=19456,t=2,p=1$' + 'A'.repeat(22) + '$' + 'B'.repeat(43)
const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
const input = { currentPassword, newPassword }
const code = expected => error => error?.code === expected

function fixture() {
  const row = { id: userId, username_normalized: 'ordinary.user', password_hash: phc, auth_version: '1' }
  const state = { principal: { userId, sessionId, deploymentId, roles: ['user'] }, row, live: row,
    csrf: true, allowed: true, verified: true, newHash: phc, calls: [], releases: [], hashes: 0,
    failAudit: false, failRollback: false, failSession: false, failRead: false, failThrottle: false }
  const one = value => ({ rowCount: value ? 1 : 0, rows: value ? [value] : [] })
  async function query(sql, params = []) {
    state.calls.push({ sql, params })
    const tag = /\/\* password-change:([a-z_]+) \*\//.exec(sql)?.[1]
    if (tag === 'read') { if (state.failRead) throw new Error('db secret'); return one(state.row) }
    if (tag === 'lock') return one(state.live)
    if (tag === 'update') return one({ auth_version: '2' })
    if (tag === 'audit' && state.failAudit) throw new Error('audit secret')
    if (sql === 'ROLLBACK' && state.failRollback) throw new Error('rollback failed')
    if (sql.startsWith('INSERT INTO dyoffice_sessions')) {
      assert.equal(params[5], '2')
      return one(state.failSession ? null : { id: params[0], expires_at: new Date() })
    }
    return { rowCount: 1, rows: [] }
  }
  const deps = { deploymentId, pool: { query, async connect() { return { query, release(e) { state.releases.push(e) } } } },
    sessionService: { async authenticate() { return state.principal } },
    csrfPolicy: { verify() { return state.csrf } },
    throttle: { async consume(args) {
      assert.equal(args.usernameNormalized, 'ordinary.user')
      assert.equal(args.ipAddress, '127.0.0.1')
      if (state.failThrottle) throw new Error('throttle secret')
      return { allowed: state.allowed }
    } },
    passwordHasher: {
      async verifyPassword(hash, value) { assert.equal(value, currentPassword); return state.verified },
      async hashPassword(value) { assert.equal(value, newPassword); state.hashes++; return state.newHash },
    },
  }
  return { state, deps, service: createPasswordChangeService(deps) }
}

test('requires session, CSRF, rate budget and correct old password before hashing or starting a transaction', async () => {
  for (const [set, expected] of [
    [s => { s.principal = null }, 'UNAUTHORIZED'], [s => { s.csrf = false }, 'FORBIDDEN'],
    [s => { s.allowed = false }, 'RATE_LIMITED'], [s => { s.verified = false }, 'INVALID_CREDENTIALS'],
  ]) {
    const f = fixture(); set(f.state)
    await assert.rejects(f.service.changePassword(request, input), code(expected))
    assert.equal(f.state.hashes, 0)
    assert.equal(f.state.calls.some(c => c.sql === 'BEGIN'), false)
  }
})

test('rejects ownership injection, weak/oversized passwords and unchanged password', async () => {
  const f = fixture()
  for (const bad of [{ ...input, userId: randomUUID() }, { ...input, newPassword: 'weak' },
    { ...input, currentPassword: 'x'.repeat(1025) }, { ...input, newPassword: currentPassword }]) {
    await assert.rejects(f.service.changePassword(request, bad), code('INVALID_INPUT'))
  }
  assert.equal(f.state.calls.some(c => c.sql === 'BEGIN'), false)
  assert.equal(f.state.hashes, 0)
})

test('ordinary user changes only authenticated account and rotates session in the same audited transaction', async () => {
  const f = fixture()
  const result = await f.service.changePassword(request, input)
  assert.notEqual(result.sessionId, sessionId)
  assert.match(result.cookie, /^__Host-dyoffice_session=[A-Za-z0-9_-]{43};/)
  assert.equal(f.state.calls.at(-1).sql, 'COMMIT')
  const update = f.state.calls.find(c => c.sql.includes('password-change:update'))
  assert.deepEqual(update.params.slice(0, 2), [deploymentId, userId])
  assert.equal(update.params[2], phc)
  for (const tag of ['revoke_sessions', 'revoke_actions', 'audit']) {
    assert.ok(f.state.calls.some(c => c.sql.includes('password-change:' + tag)), tag)
  }
  const audit = f.state.calls.find(c => c.sql.includes('password-change:audit'))
  assert.equal(audit.params.at(-1), 'password.changed')
  const recorded = JSON.stringify(f.state.calls)
  assert.equal(recorded.includes(currentPassword), false)
  assert.equal(recorded.includes(newPassword), false)
  const token = result.cookie.split(';')[0].split('=')[1]
  assert.equal(recorded.includes(token), false)
  assert.equal(f.state.releases.length, 1)
})

test('revalidates authority after hashing to reject expired/revoked session or concurrent reset', async () => {
  for (const live of [null, { id: userId, auth_version: '2', password_hash: phc },
    { id: userId, auth_version: '1', password_hash: 'changed' }]) {
    const f = fixture(); f.state.live = live
    await assert.rejects(f.service.changePassword(request, input), code('AUTHENTICATION_CHANGED'))
    assert.equal(f.state.calls.at(-1).sql, 'ROLLBACK')
    assert.equal(f.state.calls.some(c => c.sql.includes('password-change:update')), false)
  }
})

test('audit or replacement-session failure rolls back all writes and never returns a usable cookie', async () => {
  for (const field of ['failAudit', 'failSession']) {
    const f = fixture(); f.state[field] = true
    await assert.rejects(f.service.changePassword(request, input), code('UNAVAILABLE'))
    assert.equal(f.state.calls.at(-1).sql, 'ROLLBACK')
    assert.equal(f.state.calls.some(c => c.sql === 'COMMIT'), false)
  }
})

test('database errors are redacted and failed rollback discards the connection', async () => {
  const f = fixture(); f.state.failAudit = true; f.state.failRollback = true
  await assert.rejects(f.service.changePassword(request, input), e => {
    assert.equal(e.code, 'UNAVAILABLE'); assert.equal(String(e).includes('secret'), false); return true
  })
  assert.ok(f.state.releases[0] instanceof Error)
  const read = fixture(); read.state.failRead = true
  await assert.rejects(read.service.changePassword(request, input), code('UNAVAILABLE'))
  const rate = fixture(); rate.state.failThrottle = true
  await assert.rejects(rate.service.changePassword(request, input), code('UNAVAILABLE'))
})

test('rejects foreign principals, unsafe configuration and malformed hasher output', async () => {
  const f = fixture()
  assert.throws(() => createPasswordChangeService({ ...f.deps, deploymentId: 'bad' }), TypeError)
  assert.throws(() => createPasswordChangeService({ ...f.deps, idleTimeoutMs: 1 }), TypeError)
  f.state.principal = { ...f.state.principal, deploymentId: randomUUID() }
  await assert.rejects(f.service.changePassword(request, input), code('UNAUTHORIZED'))
  const hash = fixture(); hash.state.newHash = 'plain-text-password'
  await assert.rejects(hash.service.changePassword(request, input), code('UNAVAILABLE'))
  assert.equal(hash.state.calls.some(c => c.sql === 'BEGIN'), false)
})
