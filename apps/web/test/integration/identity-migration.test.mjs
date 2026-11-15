import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createIdentityStore } from '../../server/src/db/identity.ts'
import { createPasswordService } from '../../server/src/modules/auth/passwords.ts'
import { createAccountService } from '../../server/src/modules/auth/service.ts'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'

test('identity migration upgrades an existing v1 account and rejects checksum drift without losing it', async t => {
  const connectionString = process.env.DYOFFICE_TEST_DATABASE_URL
  assert.ok(connectionString, 'Real PostgreSQL required')
  assert.match(new URL(connectionString).pathname, /^\/dyoffice_test(?:_[a-z0-9_]+)?$/)
  const schema = 'identity_upgrade_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new Pool({ connectionString, options: '-c search_path=' + schema })
  t.after(async () => {
    try { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE') }
    finally { await admin.end() }
  })
  const sql = await readFile(new URL('../../server/src/db/migrations/0001_identity.sql', import.meta.url), 'utf8')
  await pool.query(sql)
  await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
  await pool.query('INSERT INTO identity_migrations VALUES(1,$1)', [createHash('sha256').update(sql).digest('hex')])
  const db = createIdentityStore(pool), deploymentId = randomUUID()
  const passwords = await createPasswordService()
  const accounts = createAccountService({ db, passwords, deploymentId })
  const password = 'upgrade lanterns float over violet rivers 9631'
  const user = await accounts.bootstrapAdmin({ username: 'owner', password })
  await db.migrate()
  await db.assertCurrent()
  assert.equal((await accounts.verifyCredentials('owner', password)).userId, user.id)
  const sessions = createSessionService({ db, accounts, deploymentId })
  assert.equal((await sessions.authenticate((await sessions.login('owner', password)).token)).userId, user.id)
  await pool.query("UPDATE identity_migrations SET sha256='tampered-test-checksum' WHERE version=2")
  await assert.rejects(() => db.migrate(), /checksum/)
  await assert.rejects(() => db.assertCurrent(), /not current/)
  assert.equal((await accounts.verifyCredentials('owner', password)).userId, user.id)
})
