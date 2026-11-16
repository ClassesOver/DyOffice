import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSelfSessionManagement } from '../server/auth/self-session-management.mjs'

const deploymentId = randomUUID(), userId = randomUUID(), sessionId = randomUUID()
const otherId = randomUUID()
const request = { headers: { cookie: 'validated elsewhere' } }
const isCode = code => error => error?.code === code
const session = id => ({ id, created_at: new Date('2026-11-01'), last_seen_at: new Date('2026-11-16'), expires_at: new Date('2026-11-17') })
function fixture() {
  const state = { principal: { deploymentId, userId, sessionId, roles: ['user'] }, csrf: true,
    live: true, records: [session(sessionId), session(otherId)], cursor: true, changed: 1,
    failAudit: false, failRollback: false, calls: [], releases: [] }
  const query = async (sql, params = []) => {
    state.calls.push({ sql, params })
    const label = /\/\* self-sessions:([\w-]+) \*\//.exec(sql)?.[1]
    if (sql === 'ROLLBACK' && state.failRollback) throw Error('broken connection')
    if (label === 'actor') return { rowCount: state.live ? 1 : 0, rows: state.live ? [{ id: userId, auth_version: '1' }] : [] }
    if (label === 'cursor') return { rowCount: state.cursor ? 1 : 0, rows: state.cursor ? [{ id: params[2] }] : [] }
    if (label === 'list') return { rowCount: state.records.length, rows: state.records }
    if (label === 'revoke' || label === 'revoke-others') return { rowCount: state.changed, rows: [] }
    if (label === 'audit' && state.failAudit) throw Error('sensitive database details')
    return { rowCount: 1, rows: [] }
  }
  const pool = { async connect() { return { query, release(error) { state.releases.push(error) } } } }
  const dependencies = { pool, deploymentId, sessionService: { async authenticate() { return state.principal } },
    csrfPolicy: { verify() { return state.csrf } } }
  return { state, dependencies, service: createSelfSessionManagement(dependencies) }
}

test('rejects unsafe dependencies and session timeouts', () => {
  const f = fixture()
  assert.throws(() => createSelfSessionManagement({ ...f.dependencies, deploymentId: 'bad' }), TypeError)
  assert.throws(() => createSelfSessionManagement({ ...f.dependencies, sessionService: null }), TypeError)
  assert.throws(() => createSelfSessionManagement({ ...f.dependencies, idleTimeoutMs: 0 }), TypeError)
})

test('lists only authenticated owner fields, with bounded pagination and no credential data', async () => {
  const f = fixture()
  f.state.records[0].session_token_hash = 'must-not-leak'
  f.state.records[0].password_hash = 'must-not-leak'
  const result = await f.service.list(request, { limit: 1 })
  assert.equal(result.sessions.length, 1)
  assert.deepEqual(Object.keys(result.sessions[0]).sort(), ['sessionId', 'createdAt', 'lastSeenAt', 'expiresAt', 'current'].sort())
  assert.equal(result.sessions[0].current, true)
  assert.equal(result.nextCursor, sessionId)
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  const q = f.state.calls.find(c => c.sql.includes('self-sessions:list'))
  assert.equal(q.params[0], deploymentId); assert.equal(q.params[1], userId)
  assert.ok(q.params.includes(2), 'read one extra row to determine next page')
  assert.match(q.sql, /revoked_at IS NULL/)
  assert.match(q.sql, /auth_version/)
  assert.equal(f.state.calls.at(-1).sql, 'COMMIT')
})

test('rejects client-selected owners and foreign/missing cursors without listing', async () => {
  const f = fixture()
  for (const input of [{ ownerId: userId }, { limit: 0 }, { limit: 101 }, { limit: '20' }, { before: 'bad' }]) {
    await assert.rejects(f.service.list(request, input), isCode('INVALID_INPUT'))
  }
  f.state.cursor = false
  await assert.rejects(f.service.list(request, { before: otherId }), isCode('INVALID_CURSOR'))
  assert.equal(f.state.calls.some(c => c.sql.includes('self-sessions:list')), false)
  const q = f.state.calls.find(c => c.sql.includes('self-sessions:cursor'))
  assert.deepEqual(q.params, [deploymentId, userId, otherId])
})

test('mutations require CSRF and a live session revalidated inside the transaction', async () => {
  const f = fixture(); f.state.csrf = false
  await assert.rejects(f.service.revoke(request, { sessionId: otherId }), isCode('FORBIDDEN'))
  assert.equal(f.state.calls.length, 0)
  f.state.csrf = true; f.state.live = false
  await assert.rejects(f.service.revokeOthers(request), isCode('UNAUTHORIZED'))
  assert.equal(f.state.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(f.state.calls.some(c => c.sql.includes('self-sessions:revoke')), false)
  f.state.principal = { ...f.state.principal, deploymentId: randomUUID() }
  await assert.rejects(f.service.list(request), isCode('UNAUTHORIZED'))
})

test('revocation is owner-scoped, idempotent and indistinguishable for foreign/missing targets', async () => {
  const f = fixture()
  const result = await f.service.revoke(request, { sessionId: otherId })
  assert.deepEqual(result, { currentRevoked: false })
  const q = f.state.calls.find(c => c.sql.includes('self-sessions:revoke */'))
  assert.deepEqual(q.params, [deploymentId, userId, otherId])
  assert.match(q.sql, /user_id = \$2/)
  assert.ok(f.state.calls.some(c => c.sql.includes('self-sessions:audit')))
  f.state.calls.length = 0; f.state.changed = 0
  assert.deepEqual(await f.service.revoke(request, { sessionId: randomUUID() }), result)
  assert.equal(f.state.calls.some(c => c.sql.includes('self-sessions:audit')), false)
})

test('current-session revocation is identified only after commit; others preserves current session', async () => {
  const f = fixture()
  assert.deepEqual(await f.service.revoke(request, { sessionId: sessionId.toUpperCase() }), { currentRevoked: true })
  assert.equal(f.state.calls.at(-1).sql, 'COMMIT')
  f.state.calls.length = 0
  assert.deepEqual(await f.service.revokeOthers(request), { currentRevoked: false })
  const q = f.state.calls.find(c => c.sql.includes('self-sessions:revoke-others'))
  assert.deepEqual(q.params, [deploymentId, userId, sessionId])
  assert.match(q.sql, /id <> \$3/)
})

test('audit failures roll back revocation and discard the connection if rollback fails', async () => {
  const f = fixture(); f.state.failAudit = true; f.state.failRollback = true
  await assert.rejects(f.service.revoke(request, { sessionId: otherId }), error => {
    assert.equal(error.code, 'UNAVAILABLE')
    assert.equal(String(error).includes('sensitive'), false)
    return true
  })
  assert.equal(f.state.calls.at(-1).sql, 'ROLLBACK')
  assert.ok(f.state.releases[0] instanceof Error)
  assert.equal(f.state.calls.some(c => c.sql === 'COMMIT'), false)
})

test('no authentication or malformed IDs cannot invoke database mutations', async () => {
  const f = fixture()
  await assert.rejects(f.service.revoke(request, { sessionId: 'bad' }), isCode('INVALID_INPUT'))
  await assert.rejects(f.service.revoke(request, { sessionId: otherId, userId }), isCode('INVALID_INPUT'))
  await assert.rejects(f.service.revokeOthers(request, { userId }), isCode('INVALID_INPUT'))
  f.state.principal = null
  await assert.rejects(f.service.list(request), isCode('UNAUTHORIZED'))
  assert.equal(f.state.calls.length, 0)
})
