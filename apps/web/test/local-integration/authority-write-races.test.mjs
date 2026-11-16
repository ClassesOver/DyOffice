import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restrictedFixture, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { password } from '../helpers/identity.mjs'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'
import { createUserService } from '../../server/src/modules/admin/users/service.ts'

const nextPassword = 'silver lanterns follow distant rivers 9753'
const credential = token => ({ kind: 'session', token })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settled = operation => operation.then(value => ({ value }), error => ({ error }))
const rollback = () => new Error('controlled authority rollback')

// Real services, real SQL and real transactions. This wrapper only pauses after
// the service has revoked the old session and before its transaction commits.
// Throwing here exercises the real transaction's ROLLBACK, not a mocked result.
function controlledRevoker(f, ready, release, fail) {
  const db = { ...f.db, transaction: operation => f.db.transaction(async connection => {
    const result = await operation(connection)
    const row = (await connection.query('SELECT revoked_at FROM sessions WHERE id=$1', [f.alice.sessionId])).rows[0]
    if (row.revoked_at) {
      ready.resolve()
      await release.promise
      if (fail) throw rollback()
    }
    return result
  }) }
  const sessions = createSessionService({ db, accounts: f.accounts, deploymentId: f.deploymentId })
  return { sessions, users: createUserService({ db, accounts: f.accounts, sessions, passwords: f.passwords, deploymentId: f.deploymentId }) }
}
function revoke(f, services, kind) {
  if (kind === 'password') return services.users.changePassword(f.alice.token, password, nextPassword)
  if (kind === 'roles') return services.users.update(f.adminSigned.token, f.alice.user.id, { roles: ['personal', 'auditor'] })
  return services.sessions.revoke(f.alice.token, f.alice.sessionId)
}
async function snapshot(f) {
  const user = (await f.ownerPool.query('SELECT password_hash,auth_version FROM users WHERE id=$1', [f.alice.user.id])).rows[0]
  const roles = (await f.ownerPool.query('SELECT role FROM user_roles WHERE user_id=$1 ORDER BY role', [f.alice.user.id])).rows
  const sessions = (await f.ownerPool.query('SELECT id,token_hash,auth_version,revoked_at FROM sessions WHERE user_id=$1 ORDER BY id', [f.alice.user.id])).rows
  return { user, roles, sessions }
}
async function readFresh(f, kind) {
  const signed = await f.sessions.login('alice', kind === 'password' ? nextPassword : password)
  return f.preferences.get(signed.token)
}
async function expectBarrier(ready, operation, label) {
  await Promise.race([ready.promise, operation.then(result => { throw result.error ?? new Error(label + ' ended before barrier') })])
}

for (const kind of ['password', 'roles', 'session']) {
  for (const failWriter of [false, true]) test(`${kind} revocation waits for an earlier business writer ${failWriter ? 'rollback' : 'commit'}, then rejects its old token`, { timeout: 20_000 }, async t => {
    const f = await restrictedFixture(t)
    await f.preferences.update(f.alice.token, { authorName: 'before' })
    const ready = deferred(), release = deferred()
    const writer = settled(f.transactions.withPrincipalTransaction(credential(f.alice.token), async connection => {
      await connection.query("UPDATE personal_preferences SET data=data||'{\"authorName\":\"writer committed\"}'::jsonb")
      ready.resolve(); await release.promise
      if (failWriter) throw new Error('controlled writer rollback')
    }))
    let revoker
    try {
      await expectBarrier(ready, writer, 'writer')
      revoker = settled(revoke(f, f, kind))
      await waitForDatabaseLock(f, 'auth')
      release.resolve()
      const written = await writer, revoked = await revoker
      if (failWriter) assert.match(written.error?.message ?? '', /controlled writer rollback/)
      else assert.equal(written.error, undefined)
      assert.equal(revoked.error, undefined)
      await assert.rejects(() => f.preferences.update(f.alice.token, { authorName: 'forbidden' }), { statusCode: 401 })
      assert.equal((await readFresh(f, kind)).authorName, failWriter ? 'before' : 'writer committed')
    } finally { release.resolve(); await Promise.allSettled([writer, revoker].filter(Boolean)) }
  })

  for (const failRevoker of [false, true]) test(`${kind} revocation ${failRevoker ? 'rollback restores' : 'commit removes'} authority for an already waiting business writer`, { timeout: 20_000 }, async t => {
    const f = await restrictedFixture(t)
    await f.preferences.update(f.alice.token, { authorName: 'before' })
    const before = await snapshot(f)
    const ready = deferred(), release = deferred()
    const revoker = settled(revoke(f, controlledRevoker(f, ready, release, failRevoker), kind))
    let writer
    try {
      await expectBarrier(ready, revoker, 'revoker')
      writer = settled(f.preferences.update(f.alice.token, { authorName: 'waiting writer' }))
      await waitForDatabaseLock(f, 'business')
      release.resolve()
      const revoked = await revoker, written = await writer
      if (failRevoker) {
        assert.match(revoked.error?.message ?? '', /controlled authority rollback/)
        assert.equal(written.error, undefined)
        assert.deepEqual(await snapshot(f), before)
        assert.equal((await f.preferences.get(f.alice.token)).authorName, 'waiting writer')
      } else {
        assert.equal(revoked.error, undefined)
        assert.equal(written.error?.statusCode, 401)
        assert.equal((await readFresh(f, kind)).authorName, 'before')
      }
    } finally { release.resolve(); await Promise.allSettled([writer, revoker].filter(Boolean)) }
  })
}
