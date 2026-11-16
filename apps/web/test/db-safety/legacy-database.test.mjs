import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createIdentityStore } from '../../server/src/db/identity.ts'
import { getMigrationManifest } from '../../server/src/db/migration-manifest.ts'

// Run separately: the guard rejects a legacy ledger anywhere in the database.
test('real PostgreSQL: hidden legacy ledger blocks migration and startup without changing either stack', async t => {
  const connectionString = process.env.DYOFFICE_LEGACY_GUARD_TEST_DATABASE_URL
  assert.ok(connectionString, 'A dedicated disposable PostgreSQL database is required')
  assert.match(new URL(connectionString).pathname, /^\/dyoffice_test_legacy_guard(?:_[a-z0-9_]+)?$/)
  const suffix = randomUUID().replaceAll('-', '')
  const legacySchema = 'legacy_' + suffix, newSchema = 'new_' + suffix
  const admin = new Pool({ connectionString })
  const pool = new Pool({ connectionString, options: '-c search_path=' + newSchema })
  t.after(async () => {
    try { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE; DROP SCHEMA IF EXISTS ${newSchema} CASCADE`) }
    finally { await admin.end() }
  })
  await admin.query(`CREATE SCHEMA ${legacySchema}; CREATE SCHEMA ${newSchema}`)
  await admin.query(`CREATE TABLE ${legacySchema}.dyoffice_schema_migrations(version text PRIMARY KEY); INSERT INTO ${legacySchema}.dyoffice_schema_migrations VALUES('existing-credentials-and-files')`)
  const db = createIdentityStore(pool)
  await assert.rejects(db.migrate(), /Legacy DyOffice database detected/)
  assert.equal((await pool.query("SELECT to_regclass('identity_migrations') AS ledger")).rows[0].ledger, null)
  // A current new ledger must not conceal legacy data outside search_path.
  await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY, sha256 text NOT NULL)')
  for (const row of await getMigrationManifest()) await pool.query('INSERT INTO identity_migrations VALUES($1,$2)', [row.version, row.sha256])
  await assert.rejects(db.assertCurrent(), /Legacy DyOffice database detected/)
  assert.deepEqual((await admin.query(`SELECT version FROM ${legacySchema}.dyoffice_schema_migrations`)).rows, [{ version: 'existing-credentials-and-files' }])
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM identity_migrations')).rows[0].count, (await getMigrationManifest()).length)
})
