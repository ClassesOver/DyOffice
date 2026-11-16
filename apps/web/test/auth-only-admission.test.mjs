import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLocalApp } from '../server/src/app.ts'

// Database responses are simulated here; the real admission function and app
// startup run unchanged. The PostgreSQL companion uses actual restricted roles.
for (const flag of ['rolsuper', 'rolbypassrls', 'rolcreaterole']) {
  test(`auth-only startup rejects ${flag} even without a business pool`, async () => {
    let app
    const pool = { async query(sql) {
      if (sql.startsWith('SELECT 1 FROM deployments')) return { rowCount: 1, rows: [{}] }
      if (sql.includes('FROM pg_roles WHERE rolname=current_user')) return { rows: [{ name: 'runtime', login: 'runtime', schema: 'public', [flag]: true }] }
      throw new Error('Unexpected query: ' + sql)
    } }
    const db = { pool, async assertCurrent() {} }
    try {
      await assert.rejects(async () => {
        app = await buildLocalApp({ db, deploymentId: '11111111-1111-4111-8111-111111111111', origin: 'https://office.example', csrfKey: 'a'.repeat(64), passwords: {} })
      }, /restricted login role/)
    } finally { await app?.close() }
  })
}
