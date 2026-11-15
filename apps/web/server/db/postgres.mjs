import pg from 'pg'

/**
 * PostgreSQL driver only for identity migration/bootstrap. Application login
 * and file access must not use this migration-role pool (T03b/T04 pending).
 */
export function createMigrationPool({ connectionString = process.env.DYOFFICE_DATABASE_URL, max = 4 } = {}) {
  if (typeof connectionString !== 'string' || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
    throw new Error('DYOFFICE_DATABASE_URL must be a PostgreSQL connection URL')
  }
  if (!Number.isSafeInteger(max) || max < 1 || max > 10) throw new TypeError('Invalid pool size')
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    application_name: 'dyoffice-identity-migration',
  })
  pool.on('error', () => {
    // Avoid dumping connection strings or credentials into logs.
    // Clients observing active operations receive the error from query().
  })
  return pool
}
