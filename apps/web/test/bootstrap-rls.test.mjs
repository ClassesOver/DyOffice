import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, copyFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { applyMigrations, readMigrations } from '../server/db/migrate.mjs'
import { bootstrapInitialAdmin } from '../server/auth/bootstrap-admin.mjs'

const databaseUrl = process.env.DYOFFICE_TEST_DATABASE_URL
const migrationDir = new URL('../server/db/migrations/', import.meta.url)
const tables = ['dyoffice_users', 'dyoffice_user_roles', 'dyoffice_personal_workspaces', 'dyoffice_admin_bootstrap']
const password = 'local bootstrap regression passphrase'
const hash = '$argon2id$v=19$m=19456,t=2,p=1$' + 'A'.repeat(22) + '$' + 'B'.repeat(43)
const passwordHasher = { async hashPassword() { return hash } }

test('bootstrap repair is forward-only and does not grant request roles its capability', async () => {
  const old = await readFile(new URL('0005_rls.sql', migrationDir))
  assert.equal(createHash('sha256').update(old).digest('hex'), '4e2d0eef3b4527f4e15c5fcc693fe6d8adc567cc09eef4daa1ab539b67a26029')
  const migrations = await readMigrations()
  const repair = migrations.find(m => m.name === '0006_bootstrap_rls.sql')
  assert.ok(repair)
  assert.doesNotMatch(repair.sql, /IF NOT EXISTS|FROM pg_roles/)
  assert.match(repair.sql, /oid::text FROM pg_catalog\.pg_database WHERE datname = pg_catalog\.current_database/ )
  assert.match(repair.sql, /GRANT %I TO %I WITH INHERIT FALSE/)
  assert.doesNotMatch(repair.sql, /GRANT dyoffice_bootstrap TO dyoffice_(app|auth)/)
  assert.doesNotMatch(repair.sql, /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|SECURITY DEFINER/)
})

test('upgrade from journaled 0005 allows non-bypass owner bootstrap but not app/auth logins', { skip: !databaseUrl && 'real PostgreSQL URL not configured', timeout: 120_000 }, async () => {
  const { createMigrationPool } = await import('../server/db/postgres.mjs')
  const suffix = randomUUID().replaceAll('-', '')
  const owner = 'boot_owner_' + suffix
  const appLogin = 'boot_app_' + suffix
  const authLogin = 'boot_auth_' + suffix
  const otherDb = 'boot_other_' + suffix
  const otherOperator = 'boot_other_owner_' + suffix
  // Identifiers are generated here, never derived from caller/HTTP input.
  for (const name of [owner, appLogin, authLogin, otherDb, otherOperator]) assert.match(name, /^[a-z_0-9]+$/)
  const admin = createMigrationPool({ connectionString: databaseUrl })
  const oldDir = await mkdtemp(join(tmpdir(), 'bootstrap-old-migrations-'))
  const database = admin
  const createdRoles = []
  let operator, app, auth, otherDatabase, otherPool, crossPool, otherBootstrapRole
  const originalOwner = (await admin.query('SELECT current_user AS name')).rows[0].name
  const quotedOwner = '"' + originalOwner.replaceAll('"', '""') + '"'
  const bootstrapRole = (await admin.query("SELECT 'dyoffice_bootstrap_' || oid::text AS role FROM pg_database WHERE datname=current_database()")).rows[0].role
  assert.match(bootstrapRole, /^dyoffice_bootstrap_[0-9]+$/)
  try {
    // Dedicated fresh CI database; run this upgrade fixture before other suites.
    // Never drop/adopt a role that was not created by this test.
    assert.equal((await admin.query('SELECT to_regrole($1) AS role', [bootstrapRole])).rows[0].role, null)
    const url = new URL(databaseUrl)
    for (const m of await readMigrations()) if (m.version <= '0005') {
      await copyFile(new URL(m.name, migrationDir), join(oldDir, m.name))
    }
    assert.equal((await applyMigrations(database, { directory: oldDir })).length, 5)
    const before = (await database.query('SELECT * FROM dyoffice_schema_migrations ORDER BY version')).rows
    // Even an unprivileged pre-existing role is untrusted: no silent reuse.
    await admin.query(`CREATE ROLE ${bootstrapRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    try {
      await assert.rejects(applyMigrations(database), /already exists/i)
      assert.equal((await database.query("SELECT version FROM dyoffice_schema_migrations WHERE version='0006'")).rowCount, 0)
    } finally { await admin.query(`DROP ROLE ${bootstrapRole}`) }
    assert.deepEqual(await applyMigrations(database), ['0006_bootstrap_rls.sql'])
    assert.deepEqual((await database.query("SELECT * FROM dyoffice_schema_migrations WHERE version <= '0005' ORDER BY version")).rows, before)
    assert.deepEqual(await applyMigrations(database), [])
    for (const role of [owner, appLogin, authLogin, otherOperator]) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'local-ci-only-not-for-production' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
      createdRoles.push(role)
    }
    await admin.query(`GRANT ${bootstrapRole} TO ${owner} WITH INHERIT FALSE`)
    await admin.query(`GRANT dyoffice_app TO ${appLogin}`)
    await admin.query(`GRANT dyoffice_auth TO ${authLogin}`)
    for (const role of [owner, appLogin, authLogin]) await database.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
    for (const table of tables) await database.query(`ALTER TABLE ${table} OWNER TO ${owner}`)
    const poolFor = (name, target = url) => {
      const u = new URL(target); u.username = name; u.password = 'local-ci-only-not-for-production'
      return createMigrationPool({ connectionString: u.toString(), max: 2 })
    }
    operator = poolFor(owner); app = poolFor(appLogin); auth = poolFor(authLogin)
    const flags = (await operator.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    assert.deepEqual(flags, { rolsuper: false, rolbypassrls: false })
    for (const pool of [app, auth]) {
      await assert.rejects(pool.query(`SET ROLE ${bootstrapRole}`), /permission denied/i)
      await assert.rejects(bootstrapInitialAdmin({ pool, passwordHasher, deploymentId: randomUUID(), username: 'forbidden.admin', displayName: 'No', password }), /setup failed/)
    }
    // Another database in the SAME cluster must install and bootstrap without
    // trusting or granting membership in this database's bootstrap role.
    await admin.query(`CREATE DATABASE ${otherDb}`)
    const otherUrl = new URL(databaseUrl); otherUrl.pathname = '/' + otherDb
    otherDatabase = createMigrationPool({ connectionString: otherUrl.toString() })
    await applyMigrations(otherDatabase)
    otherBootstrapRole = (await otherDatabase.query("SELECT 'dyoffice_bootstrap_' || oid::text AS role FROM pg_database WHERE datname=current_database()")).rows[0].role
    assert.match(otherBootstrapRole, /^dyoffice_bootstrap_[0-9]+$/)
    assert.notEqual(otherBootstrapRole, bootstrapRole)
    await admin.query(`GRANT ${otherBootstrapRole} TO ${otherOperator} WITH INHERIT FALSE`)
    otherPool = poolFor(otherOperator, otherUrl)
    crossPool = poolFor(owner, otherUrl)
    await assert.rejects(operator.query(`SET ROLE ${otherBootstrapRole}`), /permission denied/i)
    await assert.rejects(otherPool.query(`SET ROLE ${bootstrapRole}`), /permission denied/i)
    const otherInput = { passwordHasher, deploymentId: randomUUID(), username: 'other.admin', displayName: 'Other', password }
    await assert.rejects(bootstrapInitialAdmin({ ...otherInput, pool: crossPool }), /setup failed/)
    assert.ok((await bootstrapInitialAdmin({ ...otherInput, pool: otherPool })).userId)

    const deploymentId = randomUUID()
    const input = { pool: operator, passwordHasher, deploymentId, username: 'first.admin', displayName: 'Admin', password }
    const first = await bootstrapInitialAdmin(input)
    assert.ok(first.userId)
    await assert.rejects(bootstrapInitialAdmin(input), /setup failed/)
    const parallelId = randomUUID()
    const results = await Promise.allSettled(['alpha.admin', 'beta.admin'].map(username => bootstrapInitialAdmin({ ...input, deploymentId: parallelId, username })))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    for (const table of tables) assert.equal(Number((await database.query(`SELECT count(*) AS n FROM ${table} WHERE deployment_id=$1`, [parallelId])).rows[0].n), 1)
    assert.equal((await operator.query('SELECT current_user AS role')).rows[0].role, owner)
    const client = await operator.connect()
    try {
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${bootstrapRole}`)
      await assert.rejects(client.query('SELECT * FROM dyoffice_files'), /permission denied/i)
      await client.query('ROLLBACK'); await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${bootstrapRole}`)
      await assert.rejects(client.query("UPDATE dyoffice_users SET display_name='wrong'"), /permission denied/i)
      await client.query('ROLLBACK')
    } finally { client.release() }
  } finally {
    for (const pool of [operator, app, auth, otherPool, crossPool, otherDatabase]) if (pool) await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${otherDb}`)
    if (otherBootstrapRole) await admin.query(`DROP ROLE ${otherBootstrapRole}`)
    if (createdRoles.includes(owner)) await admin.query(`REASSIGN OWNED BY ${owner} TO ${quotedOwner}`)
    for (const role of createdRoles) {
      await admin.query(`DROP OWNED BY ${role}`)
      await admin.query(`DROP ROLE ${role}`)
    }
    await admin.end()
    await rm(oldDir, { recursive: true, force: true })
  }
})
