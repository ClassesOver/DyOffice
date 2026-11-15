import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jobFixture } from '../helpers/jobs.mjs'
import * as identity from '../../server/src/db/identity.ts'
import { assertRuntimePool } from '../../server/src/db/roles.ts'
test('restricted worker and business logins validate exact schema checksums without reading migration tables',async t => {
  const f = await jobFixture(t), manifest = await identity.getMigrationManifest()
  for (const pool of [f.workerPool,f.businessPool]) {
    await assert.rejects(() => pool.query('SELECT * FROM identity_migrations'),{ code: '42501' })
    const check = async value => (await pool.query('SELECT native_schema_matches($1::jsonb) AS matched',[JSON.stringify(value)])).rows[0].matched
    assert.equal(await check(manifest),true)
    assert.equal(await check(manifest.slice(1)),false)
    assert.equal(await check([...manifest,manifest[0]]),false)
    for (const malformed of [null,{},[],[{ version: -1,sha256: 'x' }]]) assert.equal(await check(malformed),false)
  }
  await assert.rejects(() => f.authPool.query('SELECT native_schema_matches($1::jsonb)',['[]']),{ code: '42501' })
})
test('worker admission rejects altered, missing or unknown migrations before any claim',async t => {
  const f = await jobFixture(t)
  const original = (await f.ownerPool.query('SELECT * FROM identity_migrations WHERE version=5')).rows[0]
  await f.ownerPool.query("UPDATE identity_migrations SET sha256=$1 WHERE version=5",['0'.repeat(64)])
  for (const pool of [f.workerPool,f.businessPool]) await assert.rejects(() => assertRuntimePool(pool,pool===f.workerPool ? 'worker' : 'business'),/schema|migration/i)
  await f.ownerPool.query('UPDATE identity_migrations SET sha256=$1 WHERE version=5',[original.sha256])
  await f.ownerPool.query('INSERT INTO identity_migrations VALUES(999,$1)',['a'.repeat(64)])
  await assert.rejects(() => assertRuntimePool(f.workerPool,'worker'),/schema|migration/i)
  await f.ownerPool.query('DELETE FROM identity_migrations WHERE version=999')
  await f.ownerPool.query('DELETE FROM identity_migrations WHERE version=5')
  await assert.rejects(() => assertRuntimePool(f.workerPool,'worker'),/schema|migration/i)
})
