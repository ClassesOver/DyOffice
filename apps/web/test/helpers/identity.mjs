import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createIdentityStore } from '../../server/src/db/identity.ts'
import { createPasswordService } from '../../server/src/modules/auth/passwords.ts'
import { createAccountService } from '../../server/src/modules/auth/service.ts'

export const password = 'violet river lanterns drift 8246'
export async function identityFixture(t) {
  const url = process.env.DYOFFICE_TEST_DATABASE_URL
  assert.ok(url, 'Real PostgreSQL required: set DYOFFICE_TEST_DATABASE_URL')
  assert.match(new URL(url).pathname, /^\/dyoffice_test(?:_[a-z0-9_]+)?$/)
  const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000, application_name: 'dyoffice-test-' + randomUUID() })
  const deploymentIds = [randomUUID()]
  const cleanup = []
  t.after(async () => {
    try {
      for (const operation of cleanup) await operation()
      for (const id of deploymentIds) {
        await pool.query('DELETE FROM password_action_tokens WHERE deployment_id=$1', [id])
        await pool.query('DELETE FROM deployments WHERE id=$1', [id])
      }
    } finally { await pool.end() }
  })
  const db = createIdentityStore(pool)
  await db.migrate()
  const deploymentId = deploymentIds[0]
  const passwords = await createPasswordService()
  const accounts = createAccountService({ db, passwords, deploymentId })
  const user = await accounts.bootstrapAdmin({ username: 'owner', password })
  return { pool, db, passwords, accounts, deploymentId, user, cleanup, deploymentIds }
}
