import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const DEFAULT_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))
const NAME = /^\d{4}_[a-z0-9_-]+\.sql$/
const MAX_SQL_BYTES = 1024 * 1024

/** Ordered, immutable migration documents. Accept no symlinks or arbitrary paths. */
export async function readMigrations(directory = DEFAULT_DIR) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && NAME.test(entry.name))
    .map(entry => entry.name).sort()
  if (names.length === 0) throw new Error('No identity migrations found')
  const versions = new Set()
  const result = []
  for (const name of names) {
    const version = name.slice(0, 4)
    if (versions.has(version)) throw new Error('Duplicate migration version ' + version)
    versions.add(version)
    const content = await readFile(join(directory, name))
    if (content.byteLength === 0 || content.byteLength > MAX_SQL_BYTES) throw new Error('Invalid migration size ' + name)
    const sql = content.toString('utf8')
    const checksum = createHash('sha256').update(content).digest('hex')
    result.push({ version, name, sql, checksum })
  }
  return result
}

/**
 * Run PostgreSQL DDL and its journal under one advisory-locked transaction.
 * Caller supplies a PostgreSQL Pool-compatible connect(); no driver or network
 * side effects occur on module import. The normal app must not run migrations.
 */
export async function applyMigrations(pool, { directory } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool required')
  const migrations = await readMigrations(directory)
  const client = await pool.connect()
  let begun = false
  try {
    await client.query('BEGIN')
    begun = true
    await client.query('SELECT pg_advisory_xact_lock(48039904259324::bigint)')
    await client.query('CREATE TABLE IF NOT EXISTS dyoffice_schema_migrations (version VARCHAR(4) PRIMARY KEY, name TEXT NOT NULL, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
    const rows = (await client.query('SELECT version, name, checksum FROM dyoffice_schema_migrations ORDER BY version')).rows
    const known = new Map(migrations.map(item => [item.version, item]))
    for (const row of rows) {
      const expected = known.get(row.version)
      if (!expected || expected.name !== row.name || expected.checksum !== row.checksum) {
        throw new Error('Migration history does not match source version ' + row.version)
      }
    }
    const applied = new Set(rows.map(row => row.version))
    const newlyApplied = []
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      await client.query(migration.sql)
      await client.query(
        'INSERT INTO dyoffice_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      )
      newlyApplied.push(migration.name)
    }
    await client.query('COMMIT')
    begun = false
    return newlyApplied
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
