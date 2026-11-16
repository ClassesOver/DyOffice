import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restrictedFixture, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { password } from '../helpers/identity.mjs'

const credential = token => ({ kind: 'session', token })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('a business writer holds authority locks through commit before disable can commit', { timeout: 15_000 }, async t => {
  const f = await restrictedFixture(t)
  await f.preferences.update(f.alice.token, { authorName: 'before' })
  const ready = deferred(), release = deferred()
  const writer = f.transactions.withPrincipalTransaction(credential(f.alice.token), async connection => {
    await connection.query("UPDATE personal_preferences SET data=data||'{\"authorName\":\"committed first\"}'::jsonb")
    ready.resolve(); await release.promise
  })
  let disable
  try {
    await Promise.race([ready.promise, writer.then(() => { throw new Error('Writer ended before barrier') })])
    disable = f.users.update(f.adminSigned.token, f.alice.user.id, { status: 'disabled' })
    await waitForDatabaseLock(f, 'auth')
    release.resolve()
    await writer; await disable
    await assert.rejects(() => f.preferences.update(f.alice.token, { authorName: 'must not commit' }), { statusCode: 401 })
    await f.users.update(f.adminSigned.token, f.alice.user.id, { status: 'active' })
    const fresh = await f.sessions.login('alice', password)
    assert.equal((await f.preferences.get(fresh.token)).authorName, 'committed first')
  } finally { release.resolve(); await Promise.allSettled([writer, disable].filter(Boolean)) }
})

test('a disable committed first makes a waiting business writer reject without changing data', { timeout: 15_000 }, async t => {
  const f = await restrictedFixture(t)
  await f.preferences.update(f.alice.token, { authorName: 'unchanged' })
  const ready = deferred(), release = deferred()
  const revoker = f.sessions.withAuthority(f.adminSigned.token, { userIds: [f.alice.user.id], lockUsers: 'update', lockAllCredentials: true, guardAdmins: true, requireAdmin: true, requireRecent: true }, async ({ connection }) => {
    await connection.query("UPDATE users SET status='disabled',auth_version=auth_version+1 WHERE id=$1", [f.alice.user.id])
    await connection.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE deployment_id=$1 AND user_id=$2', [f.deploymentId, f.alice.user.id])
    ready.resolve(); await release.promise
  })
  let writer
  try {
    await Promise.race([ready.promise, revoker.then(() => { throw new Error('Revoker ended before barrier') })])
    writer = f.preferences.update(f.alice.token, { authorName: 'forbidden stale write' }).then(value => ({ value }), error => ({ error }))
    await waitForDatabaseLock(f, 'business')
    release.resolve(); await revoker
    assert.equal((await writer).error?.statusCode, 401)
    await f.users.update(f.adminSigned.token, f.alice.user.id, { status: 'active' })
    const fresh = await f.sessions.login('alice', password)
    assert.equal((await f.preferences.get(fresh.token)).authorName, 'unchanged')
  } finally { release.resolve(); await Promise.allSettled([writer, revoker].filter(Boolean)) }
})

test('self-session revocation waits for the active business transaction and blocks subsequent writes', { timeout: 15_000 }, async t => {
  const f = await restrictedFixture(t)
  const ready = deferred(), release = deferred()
  const writer = f.transactions.withPrincipalTransaction(credential(f.alice.token), async connection => { await connection.query('SELECT * FROM workspaces'); ready.resolve(); await release.promise })
  let revoke
  try {
    await Promise.race([ready.promise, writer.then(() => { throw new Error('Writer ended early') })])
    revoke = f.sessions.revoke(f.alice.token, f.alice.sessionId)
    await waitForDatabaseLock(f, 'auth')
    release.resolve(); await writer; await revoke
    await assert.rejects(() => f.preferences.update(f.alice.token, { theme: 'dark' }), { statusCode: 401 })
  } finally { release.resolve(); await Promise.allSettled([writer, revoke].filter(Boolean)) }
})

test('business authority independently rejects expired, idle, revoked and version-mismatched credentials', async t => {
  const f = await restrictedFixture(t)
  for (const mutation of [
    "created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day'",
    "last_seen_at=clock_timestamp()-interval '9 hours'",
    'revoked_at=clock_timestamp()',
    'auth_version=auth_version+1',
  ]) {
    const signed = await f.sessions.login('alice', password)
    await f.authPool.query('UPDATE sessions SET ' + mutation + ' WHERE id=$1', [signed.sessionId])
    await assert.rejects(() => f.preferences.get(signed.token), { statusCode: 401 })
  }
  const signed = await f.sessions.login('alice', password)
  await f.authPool.query('UPDATE users SET password_reset_required=true WHERE id=$1', [f.alice.user.id])
  await assert.rejects(() => f.preferences.get(signed.token), { statusCode: 401 })
})
