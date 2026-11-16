import test from 'node:test'
import assert from 'node:assert/strict'
import { restrictedFixture } from '../helpers/restricted.mjs'
import { loadMigrations } from '../../server/src/db/migration-manifest.ts'
import { tokenHash } from '../../server/src/modules/auth/sessions.ts'

test('existing v13 database upgrades forward and rejects NULL idle at restricted function boundary', async t => {
  const migrations = await loadMigrations()
  const f = await restrictedFixture(t, { beforeMigrate: async pool => {
    await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
    for (const m of migrations.filter(m => m.version <= 13)) {
      await pool.query(m.sql)
      await pool.query('INSERT INTO identity_migrations(version,sha256) VALUES($1,$2)', [m.version,m.digest])
    }
  } })
  assert.deepEqual((await f.ownerPool.query('SELECT version,sha256 FROM identity_migrations ORDER BY version')).rows,
    migrations.map(m => ({ version: m.version,sha256: m.digest })))
  const acl = async () => (await f.ownerPool.query("SELECT proacl::text AS acl FROM pg_proc WHERE oid='lock_business_session(uuid,text,bigint)'::regprocedure")).rows[0].acl
  const granted = await acl()
  await f.ownerPool.query(migrations.find(m => m.version === 14).sql)
  assert.equal(await acl(), granted, 'CREATE OR REPLACE must preserve runtime grants')
  const query = idle => f.businessPool.query('SELECT * FROM lock_business_session($1,$2,$3)', [f.deploymentId,tokenHash(f.alice.token),idle])
  for (const idle of [null, 0, -1, 2592000001]) await assert.rejects(query(idle), { code: '28000' })
  await assert.rejects(f.businessPool.query('SELECT * FROM lock_business_session($1,$2,$3)', [f.deploymentId,null,1000]), { code: '28000' })
  assert.equal((await query(2592000000)).rows[0].user_id, f.alice.user.id)
  await f.ownerPool.query("UPDATE sessions SET last_seen_at=clock_timestamp()-interval '1 hour' WHERE deployment_id=$1 AND token_hash=$2", [f.deploymentId,tokenHash(f.alice.token)])
  await assert.rejects(query(1000), { code: '28000' })
  await assert.rejects(query(null), { code: '28000' })
})
