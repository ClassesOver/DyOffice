import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { applyMigrations } from '../../server/db/migrate.mjs'
import { createMigrationPool } from '../../server/db/postgres.mjs'
import { createPasswordHasher } from '../../server/auth/passwords.mjs'
import { bootstrapInitialAdmin } from '../../server/auth/bootstrap-admin.mjs'
import { inspectArgon2idHash } from '../../server/auth/credential-policy.mjs'

const dbUrl = process.env.DYOFFICE_TEST_DATABASE_URL
if (!dbUrl) throw new Error('DYOFFICE_TEST_DATABASE_URL required: this test must run against real PostgreSQL')

test('real PostgreSQL migration, Argon2id password verification and concurrent first admin', { timeout: 120_000 }, async () => {
  const pool = createMigrationPool({ connectionString: dbUrl, max: 5 })
  const hasher = createPasswordHasher({ maxConcurrent: 2 })
  const password = 'Some really long 🧠 passphrase 2026'
  try {
    assert.deepEqual(await applyMigrations(pool), ['0001_identity.sql','0002_login_rate_limits.sql'])
    assert.deepEqual(await applyMigrations(pool), [])

    const hash = await hasher.hashPassword(password)
    assert.ok(inspectArgon2idHash(hash), 'must be Argon2id PHC')
    assert.notEqual(hash, password)
    assert.equal(await hasher.verifyPassword(hash, password), true)
    assert.equal(await hasher.verifyPassword(hash, 'not the real passphrase'), false)
    assert.equal(await hasher.verifyPassword('invalid', password), false)
    const malformedHash = String.fromCharCode(36) + ['argon2id', 'v=19', 'm=19456,t=2,p=1', 'A'.repeat(22), 'B'.repeat(43)].join(String.fromCharCode(36))
    assert.equal(await hasher.verifyPassword(malformedHash, password), false)
    assert.notEqual(hash, await hasher.hashPassword(password), 'random salt should differ')

    const deploymentId = randomUUID()
    const first = await bootstrapInitialAdmin({
      pool, passwordHasher: hasher, deploymentId,
      username: '  Root.Admin  ', displayName: 'Root admin', password,
    })
    assert.equal(first.username, 'root.admin')
    const row = (await pool.query('SELECT password_hash, status FROM dyoffice_users WHERE id = $1', [first.userId])).rows[0]
    assert.equal(row.status, 'active')
    assert.ok(inspectArgon2idHash(row.password_hash))
    assert.equal(await hasher.verifyPassword(row.password_hash, password), true)
    await assert.rejects(
      bootstrapInitialAdmin({pool,passwordHasher:hasher,deploymentId,username:'root.again',displayName:'Second',password}),
      /setup failed/,
    )
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM dyoffice_users WHERE deployment_id = $1', [deploymentId])).rows[0].n), 1)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM dyoffice_admin_bootstrap WHERE deployment_id = $1', [deploymentId])).rows[0].n), 1)

    // Two independent Postgres clients with DIFFERENT usernames must still
    // produce exactly one initial admin, even with concurrent snapshots.
    const concurrentDeployment = randomUUID()
    const started = await Promise.allSettled(['alpha.admin', 'beta.admin'].map(username => bootstrapInitialAdmin({
      pool, passwordHasher:hasher, deploymentId:concurrentDeployment, username,
      displayName:username, password,
    })))
    assert.equal(started.filter(x => x.status === 'fulfilled').length, 1)
    assert.equal(started.filter(x => x.status === 'rejected').length, 1)
    const count = (table) => pool.query(
      `SELECT count(*) AS n FROM ${table} WHERE deployment_id = $1`, [concurrentDeployment],
    ).then(result => Number(result.rows[0].n))
    assert.equal(await count('dyoffice_users'), 1)
    assert.equal(await count('dyoffice_user_roles'), 1)
    assert.equal(await count('dyoffice_personal_workspaces'), 1)
    assert.equal(await count('dyoffice_admin_bootstrap'), 1)
  } finally {
    await pool.end()
  }
})
