import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityStore } from '../server/src/db/identity.ts'
import { getMigrationManifest } from '../server/src/db/migration-manifest.ts'

function database({ legacy = false, probeError = null } = {}) {
  const queries = []
  let released = false
  const query = async (sql) => {
    queries.push(sql)
    if (sql.includes('pg_catalog.pg_class')) {
      if (probeError) throw probeError
      return { rowCount: legacy ? 1 : 0, rows: legacy ? [{ schema_name: 'old_private' }] : [] }
    }
    if (sql.includes('SELECT version,sha256')) {
      const rows = await getMigrationManifest()
      return { rowCount: rows.length, rows }
    }
    return { rowCount: 0, rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() { released = true } }) }
  return { db: createIdentityStore(pool), queries, released: () => released }
}

test('migration rejects a legacy ledger before any DDL and rolls back/releases', async () => {
  const { db, queries, released } = database({ legacy: true })
  await assert.rejects(db.migrate(), /Legacy DyOffice database detected/)
  assert.equal(queries.some(sql => /^(CREATE|INSERT|ALTER|DROP)/.test(sql)), false)
  assert.equal(queries.at(-1), 'ROLLBACK')
  assert.equal(released(), true)
})

test('startup refuses a legacy ledger even if the new migration manifest is current', async () => {
  const { db, queries } = database({ legacy: true })
  await assert.rejects(db.assertCurrent(), /Legacy DyOffice database detected/)
  assert.equal(queries.some(sql => sql.includes('SELECT version,sha256')), false)
})

test('catalog query failure is not treated as absence during migration or startup', async () => {
  for (const method of ['migrate', 'assertCurrent']) {
    const { db, queries } = database({ probeError: new Error('catalog unavailable') })
    await assert.rejects(db[method](), /catalog unavailable/)
    assert.equal(queries.some(sql => /^(CREATE|INSERT|ALTER|DROP)/.test(sql)), false)
  }
})

test('a clean database still migrates and a current new-stack database starts', async () => {
  const { db, queries } = database()
  await db.migrate()
  await db.assertCurrent()
  const probe = queries.findIndex(sql => sql.includes('pg_catalog.pg_class'))
  const ddl = queries.findIndex(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS identity_migrations'))
  assert.ok(probe >= 0 && probe < ddl)
  assert.ok(queries.includes('COMMIT'))
})
