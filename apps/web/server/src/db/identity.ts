import { Pool, type PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { loadMigrations } from './migration-manifest.ts'
export { getMigrationManifest } from './migration-manifest.ts'
import * as schema from './schema.ts'

// The legacy and new identity stacks have incompatible migration ledgers and
// ownership models. Require a dedicated database, not merely a new search_path.
// Catalog lookup also detects an old ledger hidden in a different/private schema
// without requiring SELECT access to the legacy table or reading its contents.
async function assertDedicatedIdentityDatabase(connection: Pick<PoolClient, 'query'>) {
  const legacy = await connection.query(
    "SELECT 1 FROM pg_catalog.pg_class WHERE relname=$1 AND relkind IN ('r','p','v','m','f') LIMIT 1",
    ['dyoffice_schema_migrations'],
  )
  if (legacy.rows.length) {
    throw new Error('Legacy DyOffice database detected. Use a separate database for the local identity stack; an explicit data migration is required. Do not delete or rename the legacy migration ledger.')
  }
}

export function createIdentityStore(pool: Pool) {
  async function transaction<T>(operation: (connection: PoolClient) => Promise<T>): Promise<T> {
    const connection = await pool.connect()
    let releaseError: Error | undefined
    try {
      await connection.query('BEGIN')
      await connection.query("SET LOCAL lock_timeout='5s'")
      await connection.query("SET LOCAL statement_timeout='10s'")
      const result = await operation(connection)
      await connection.query('COMMIT')
      return result
    } catch (error) {
      try { await connection.query('ROLLBACK') }
      catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed') }
      throw error
    } finally { connection.release(releaseError) }
  }
  return {
    pool, orm: drizzle(pool, { schema }), transaction,
    async assertCurrent() {
      await assertDedicatedIdentityDatabase(pool)
      const rows = await pool.query('SELECT version,sha256 FROM identity_migrations ORDER BY version')
      const migrations = await loadMigrations()
      if (rows.rowCount !== migrations.length || migrations.some((m, i) => rows.rows[i].version !== m.version || rows.rows[i].sha256 !== m.digest)) throw new Error('Identity migrations are not current')
    },
    async migrate() {
      const migrations = await loadMigrations()
      await transaction(async connection => {
        await connection.query('SELECT pg_advisory_xact_lock(733920101)')
        await assertDedicatedIdentityDatabase(connection)
        await connection.query('CREATE TABLE IF NOT EXISTS identity_migrations(version integer PRIMARY KEY, sha256 text NOT NULL)')
        const versions = await connection.query('SELECT version FROM identity_migrations')
        if (versions.rows.some(row => !migrations.some(m => m.version === row.version))) throw new Error('Unknown identity migration version')
        for (const migration of migrations) {
          const applied = await connection.query('SELECT sha256 FROM identity_migrations WHERE version=$1', [migration.version])
          if (applied.rowCount) {
            if (applied.rows[0].sha256 !== migration.digest) throw new Error('Identity migration checksum mismatch')
          } else {
            await connection.query(migration.sql)
            await connection.query('INSERT INTO identity_migrations(version,sha256) VALUES($1,$2)', [migration.version, migration.digest])
          }
        }
      })
    },
  }
}
export type IdentityStore = ReturnType<typeof createIdentityStore>
export function connectIdentityStore(connectionString: string) {
  const pool = new Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000 })
  return { db: createIdentityStore(pool), close: () => pool.end() }
}
