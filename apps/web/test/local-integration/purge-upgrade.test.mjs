import test from 'node:test'
import assert from 'node:assert/strict'
import { restrictedFixture } from '../helpers/restricted.mjs'
import { loadMigrations } from '../../server/src/db/migration-manifest.ts'

test('v15 database upgrades forward to reclamation/purge without changing applied ledger or ACK grants', async t => {
  const migrations = await loadMigrations()
  let before, authority
  const ack = async pool => (await pool.query("SELECT oid,proowner,proacl,prosecdef,proconfig FROM pg_proc WHERE oid='ack_revision_delivery(uuid,uuid,bigint,text,integer)'::regprocedure")).rows[0]
  const f = await restrictedFixture(t, { worker: true, beforeMigrate: async pool => {
    await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
    for (const migration of migrations.filter(m => m.version <= 15)) {
      await pool.query(migration.sql)
      await pool.query('INSERT INTO identity_migrations VALUES($1,$2)', [migration.version,migration.digest])
    }
    const owner = (await pool.query('SELECT current_user AS name')).rows[0].name
    await pool.query('GRANT EXECUTE ON FUNCTION ack_revision_delivery(uuid,uuid,bigint,text,integer) TO '+owner.replace(/_owner$/, '_worker'))
    before = (await pool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
    authority = await ack(pool)
  } })
  const after = (await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
  assert.deepEqual(after.slice(0,15), before)
  assert.deepEqual(after.map(m => m.version), Array.from({ length: migrations.length }, (_, i) => i + 1))
  assert.deepEqual(await ack(f.ownerPool), authority)
  await f.ownerDb.migrate()
  assert.deepEqual((await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows, after)
  const guards = (await f.ownerPool.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='guard_file_lifecycle()'::regprocedure")).rows[0]
  assert.equal(guards.prosecdef, false)
  assert.ok(guards.proconfig.includes('search_path=pg_catalog'))
})
