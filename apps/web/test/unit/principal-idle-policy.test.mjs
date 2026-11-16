import test from 'node:test'
import assert from 'node:assert/strict'
import { createPrincipalTransactions } from '../../server/src/db/context.ts'
import { loadMigrations } from '../../server/src/db/migration-manifest.ts'

const deploymentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const pool = new Proxy({}, { get() { throw new Error('Validation must precede database access') } })
test('principal transaction factory rejects invalid idle lifetime before database access', () => {
  for (const idleMs of [null, NaN, Infinity, 0, -1, 0.5, 2592000001, '1000']) {
    assert.throws(() => createPrincipalTransactions({ pool, deploymentId, idleMs }), /Invalid session idle lifetime/)
  }
})
test('principal transaction factory retains default and valid inclusive boundaries', () => {
  assert.equal(createPrincipalTransactions({ pool, deploymentId }).sessionIdleMs, 28800000)
  for (const idleMs of [1, 1000, 2592000000]) assert.equal(createPrincipalTransactions({ pool, deploymentId, idleMs }).sessionIdleMs, idleMs)
})
test('forward migration explicitly rejects null idle values without rewriting historical RLS migration', async () => {
  const migrations = await loadMigrations()
  assert.equal(migrations.find(m => m.version === 4).digest, '249e1688ec9b0e0b22a34b35320b56f635f8cb0ff764606969767aa5f714457a')
  const forward = migrations.find(m => m.version === 14)
  assert.ok(forward, 'session idle guard must be an appended migration')
  assert.match(forward.sql, /CREATE OR REPLACE FUNCTION/)
  assert.match(forward.sql, /p_idle_ms IS NULL OR p_idle_ms<1 OR p_idle_ms>2592000000/)
  assert.match(forward.sql, /SECURITY DEFINER SET search_path=pg_catalog/)
})
