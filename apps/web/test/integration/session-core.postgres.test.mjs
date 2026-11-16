import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createMigrationPool } from '../../server/db/postgres.mjs'
import { applyMigrations } from '../../server/db/migrate.mjs'
import { createSessionService, SESSION_COOKIE_NAME } from '../../server/auth/session-core.mjs'
import { createPasswordHasher } from '../../server/auth/passwords.mjs'
import { bootstrapInitialAdmin } from '../../server/auth/bootstrap-admin.mjs'

const databaseUrl = process.env.DYOFFICE_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DYOFFICE_TEST_DATABASE_URL is required')

const requestFor = issued => ({
  headers: {cookie: issued.cookie.split(';')[0]},
  rawHeaders: ['Cookie', issued.cookie.split(';')[0]],
})

test('PostgreSQL sessions bind to active owner, deployment, auth version and revocation', {timeout:120_000}, async () => {
  const pool = createMigrationPool({connectionString:databaseUrl, max:4})
  try {
    await applyMigrations(pool)
    const deploymentId = randomUUID()
    const otherDeployment = randomUUID()
    const password = 'An unusual 2026 long passphrase!'
    const admin = await bootstrapInitialAdmin({
      pool,
      passwordHasher:createPasswordHasher({maxConcurrent:1}),
      deploymentId,
      username:'operator.admin',
      displayName:'Admin',
      password,
    })
    const sessions = createSessionService({pool, idleTimeoutMs: 60 * 60 * 1000})
    const first = await sessions.issue({deploymentId,userId:admin.userId})
    assert.ok(first)
    assert.match(first.cookie, new RegExp('^' + SESSION_COOKIE_NAME + '=[A-Za-z0-9_-]{43};'))
    const req = requestFor(first)
    const sessionHash = (await pool.query(
      'SELECT session_token_hash FROM dyoffice_sessions WHERE id=$1', [first.sessionId],
    )).rows[0].session_token_hash
    const token = req.headers.cookie.slice(SESSION_COOKIE_NAME.length + 1)
    assert.ok(sessionHash.equals(createHash('sha256').update(token).digest()))
    assert.notEqual(sessionHash.toString('hex'), Buffer.from(token).toString('hex'))
    const principal = await sessions.authenticate(req, {deploymentId})
    assert.equal(principal.userId, admin.userId)
    assert.equal(principal.sessionId, first.sessionId)
    assert.deepEqual(principal.roles, ['config_admin'])
    assert.equal(await sessions.authenticate(req, {deploymentId:otherDeployment}),null)

    await pool.query(
      "UPDATE dyoffice_user_roles SET role='user' WHERE deployment_id=$1 AND user_id=$2",
      [deploymentId,admin.userId],
    )
    assert.deepEqual((await sessions.authenticate(req, {deploymentId})).roles,['user'])

    // Password/role changes advance auth_version; old sessions lose authority.
    await pool.query('UPDATE dyoffice_users SET auth_version=auth_version+1 WHERE id=$1', [admin.userId])
    assert.equal(await sessions.authenticate(req, {deploymentId}),null)
    assert.equal(await sessions.revoke(req, {deploymentId}), true)
    assert.equal(await sessions.revoke(req, {deploymentId}), false)

    const second = await sessions.issue({deploymentId,userId:admin.userId})
    const secondReq = requestFor(second)
    assert.ok(await sessions.authenticate(secondReq,{deploymentId}))
    assert.equal(await sessions.revokeAllForUser({deploymentId:otherDeployment,userId:admin.userId}),0)
    assert.equal(await sessions.revokeAllForUser({deploymentId,userId:admin.userId}),1)
    assert.equal(await sessions.authenticate(secondReq,{deploymentId}),null)

    const third = await sessions.issue({deploymentId,userId:admin.userId})
    await pool.query(
      "UPDATE dyoffice_sessions SET last_seen_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [third.sessionId],
    )
    assert.equal(await sessions.authenticate(requestFor(third),{deploymentId}),null, 'idle session must expire')

    const fourth = await sessions.issue({deploymentId,userId:admin.userId})
    await pool.query(
      "UPDATE dyoffice_sessions SET created_at=clock_timestamp()-interval '3 days', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [fourth.sessionId],
    )
    assert.equal(await sessions.authenticate(requestFor(fourth),{deploymentId}),null, 'absolute expiry must deny')

    const fifth = await sessions.issue({deploymentId,userId:admin.userId})
    assert.ok(fifth)
    await pool.query("UPDATE dyoffice_users SET status='disabled', disabled_at=clock_timestamp() WHERE id=$1", [admin.userId])
    assert.equal(await sessions.authenticate(requestFor(fifth),{deploymentId}),null)
    assert.equal(await sessions.issue({deploymentId,userId:admin.userId}),null)
    assert.equal(await sessions.issue({deploymentId,userId:randomUUID()}),null)

    // A token with a plausible cookie shape but unknown digest is always rejected.
    const spoof = {headers:{cookie:SESSION_COOKIE_NAME+'='+'A'.repeat(43)}}
    assert.equal(await sessions.authenticate(spoof,{deploymentId}),null)
  } finally {
    await pool.end()
  }
})
