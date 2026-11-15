import { Pool, type PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as schema from './schema.ts'

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
    async migrate() {
      const sql = await readFile(new URL('./migrations/0001_identity.sql', import.meta.url), 'utf8')
      const digest = createHash('sha256').update(sql).digest('hex')
      await transaction(async connection => {
        // Serialize DDL across bootstrap/test processes before creating the ledger.
        await connection.query('SELECT pg_advisory_xact_lock(733920101)')
        await connection.query('CREATE TABLE IF NOT EXISTS identity_migrations(version integer PRIMARY KEY, sha256 text NOT NULL)')
        const applied = await connection.query('SELECT sha256 FROM identity_migrations WHERE version=1')
        if (applied.rowCount) {
          if (applied.rows[0].sha256 !== digest) throw new Error('Identity migration checksum mismatch')
          return
        }
        await connection.query(sql)
        await connection.query('INSERT INTO identity_migrations(version,sha256) VALUES(1,$1)', [digest])
      })
    },
  }
}
export type IdentityStore = ReturnType<typeof createIdentityStore>
export function connectIdentityStore(connectionString: string) {
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 })
  return { db: createIdentityStore(pool), close: () => pool.end() }
}
