import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restrictedFixture } from '../helpers/restricted.mjs'
import { loadMigrations } from '../../server/src/db/migration-manifest.ts'
test('v21 upgrades to abandonment without rewriting prior ledger ACK T05 T12 T13 or session authority', async (t) => {
  const migrations = await loadMigrations()
  let before, functions
  const read = async (p) =>
    (
      await p.query(
        "SELECT oid,proowner,prosrc,prosecdef,proconfig FROM pg_proc WHERE oid=ANY(ARRAY['ack_revision_delivery(uuid,uuid,bigint,text,integer)'::regprocedure,'guard_file_lifecycle()'::regprocedure,'lock_business_session(uuid,text,bigint)'::regprocedure,'global_config_authorized(uuid,boolean)'::regprocedure,'commit_bound_command()'::regprocedure,'provider_budget_action(text,text,text,integer,text,uuid)'::regprocedure]) ORDER BY oid",
      )
    ).rows
  const f = await restrictedFixture(t, {
    worker: true,
    beforeMigrate: async (p) => {
      await p.query(
        'CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)',
      )
      for (const m of migrations.filter((m) => m.version <= 21)) {
        await p.query(m.sql)
        await p.query('INSERT INTO identity_migrations VALUES($1,$2)', [m.version, m.digest])
      }
      before = (await p.query('SELECT * FROM identity_migrations ORDER BY version')).rows
      functions = await read(p)
    },
  })
  const after = (await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
  assert.deepEqual(after.slice(0, 21), before)
  assert.equal(after.at(-1).version, 22)
  assert.deepEqual(await read(f.ownerPool), functions)
  await f.ownerDb.migrate()
  assert.deepEqual(
    (await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows,
    after,
  )
  await assert.rejects(() => f.workerPool.query('SELECT * FROM command_journal'), { code: '42501' })
})
