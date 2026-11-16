import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createIdentityStore } from '../../server/src/db/identity.ts'
import { createPasswordService } from '../../server/src/modules/auth/passwords.ts'
import { createAccountService } from '../../server/src/modules/auth/service.ts'

const phrase = 'violet river lanterns drift 8246'

async function fixture(t) {
  const url = process.env.DYOFFICE_TEST_DATABASE_URL
  assert.ok(url, 'Real PostgreSQL required: set DYOFFICE_TEST_DATABASE_URL to a disposable test database')
  const parsed = new URL(url)
  assert.match(parsed.pathname, /^\/dyoffice_test(?:_[a-z0-9_]+)?$/)
  const pool = new Pool({ connectionString: url, max: 4 })
  const deploymentIds = []
  t.after(async () => {
    try { for (const id of deploymentIds) await pool.query('DELETE FROM deployments WHERE id=$1', [id]) }
    finally { await pool.end() }
  })
  const db = createIdentityStore(pool)
  await db.migrate()
  const deploymentId = randomUUID()
  deploymentIds.push(deploymentId)
  const passwords = await createPasswordService()
  const service = createAccountService({ db, passwords, deploymentId })
  return { pool, db, passwords, service, deploymentId, deploymentIds }
}

test('first-admin bootstrap is atomic under concurrency and normalizes the unique login', async t => {
  const { service, pool, deploymentId } = await fixture(t)
  const outcomes = await Promise.allSettled([
    service.bootstrapAdmin({ username: '  Owner  ', password: phrase }),
    service.bootstrapAdmin({ username: 'owner', password: phrase }),
  ])
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  const failed = outcomes.find(x => x.status === 'rejected')
  assert.equal(failed.reason.code, 'BOOTSTRAP_CLOSED')
  const { rows } = await pool.query('SELECT username_normalized, password_hash FROM users WHERE deployment_id=$1', [deploymentId])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].username_normalized, 'owner')
  assert.match(rows[0].password_hash, /^\$argon2id\$/)
  const user = outcomes.find(x => x.status === 'fulfilled').value
  assert.equal(user.username, 'owner')
  assert.equal('passwordHash' in user, false)
  assert.equal((await pool.query('SELECT * FROM workspaces WHERE deployment_id=$1', [deploymentId])).rowCount, 1)
  assert.equal((await pool.query('SELECT * FROM auth_audit_events WHERE deployment_id=$1', [deploymentId])).rowCount, 1)
  // Closure is durable even if the initial administrator is later disabled/demoted.
  await pool.query('DELETE FROM user_roles WHERE deployment_id=$1', [deploymentId])
  await assert.rejects(() => service.bootstrapAdmin({ username: 'another', password: phrase }), { code: 'BOOTSTRAP_CLOSED' })
})

test('bootstrap rejects missing or blocked passwords without creating an account or default', async t => {
  const { service, pool, deploymentId } = await fixture(t)
  for (const password of [undefined, '', 'short', 'passwordpassword']) {
    await assert.rejects(() => service.bootstrapAdmin({ username: 'owner', password }), { code: 'INVALID_PASSWORD' })
  }
  assert.equal((await pool.query('SELECT * FROM users WHERE deployment_id=$1', [deploymentId])).rowCount, 0)
})

test('password verification uses generic rejection for unknown, wrong and disabled identities', async t => {
  const { service, pool, deploymentId, deploymentIds } = await fixture(t)
  const user = await service.bootstrapAdmin({ username: 'owner', password: phrase })
  const verified = await service.verifyCredentials(' OWNER ', phrase)
  assert.equal(verified.userId, user.id)
  assert.equal(verified.deploymentId, deploymentId)
  assert.equal('passwordHash' in verified, false)
  for (const [username, password] of [['owner', 'wrong password phrase'], ['missing', phrase], ['аwner', phrase]]) {
    assert.equal(await service.verifyCredentials(username, password), null)
  }
  await pool.query("UPDATE users SET status='disabled',auth_version=auth_version+1 WHERE id=$1", [user.id])
  assert.equal(await service.verifyCredentials('owner', phrase), null)
})

test('database constraints prevent case duplicates, cross-deployment role/workspace/session links', async t => {
  const { service, pool, deploymentId, deploymentIds } = await fixture(t)
  const user = await service.bootstrapAdmin({ username: 'owner', password: phrase })
  const { rows: [stored] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.id])
  await assert.rejects(() => pool.query("INSERT INTO users(id,deployment_id,username_normalized,password_hash,status) VALUES($1,$2,'OWNER',$3,'active')", [randomUUID(), deploymentId, stored.password_hash]), { code: '23514' })
  await assert.rejects(() => pool.query("INSERT INTO users(id,deployment_id,username_normalized,password_hash,status) VALUES($1,$2,'owner',$3,'active')", [randomUUID(), deploymentId, stored.password_hash]), { code: '23505' })
  const otherDeployment = randomUUID()
  await pool.query('INSERT INTO deployments(id) VALUES($1)', [otherDeployment])
  deploymentIds.push(otherDeployment)
  await assert.rejects(() => pool.query("INSERT INTO user_roles(deployment_id,user_id,role) VALUES($1,$2,'config_admin')", [otherDeployment, user.id]), { code: '23503' })
  await assert.rejects(() => pool.query('INSERT INTO workspaces(id,deployment_id,owner_id) VALUES($1,$2,$3)', [randomUUID(), otherDeployment, user.id]), { code: '23503' })
  await assert.rejects(() => pool.query("INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,1,now()+interval '1 hour')", [randomUUID(), otherDeployment, user.id, 'a'.repeat(64)]), { code: '23503' })
})

test('interactive bootstrap accepts immediate terminal input without echoing the password', { timeout: 12_000 }, async t => {
  const { pool, deploymentId } = await fixture(t)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { stdout } = await promisify(execFile)('python3', [
    fileURLToPath(new URL('../helpers/bootstrap-pty.py', import.meta.url)),
    fileURLToPath(new URL('../../../../tools/dyoffice/bootstrap-admin.ts', import.meta.url)),
    process.execPath,
  ], { env: { ...process.env, DYOFFICE_DATABASE_URL: process.env.DYOFFICE_TEST_DATABASE_URL, DYOFFICE_DEPLOYMENT_ID: deploymentId, DYOFFICE_ADMIN_PASSWORD: '', DYOFFICE_USER_TOKEN: '', DYOFFICE_ADMIN_TOKEN: '' } })
  assert.match(stdout, /without echoing/)
  const { rows } = await pool.query('SELECT username_normalized FROM users WHERE deployment_id=$1', [deploymentId])
  assert.deepEqual(rows, [{ username_normalized: 'cli.owner' }])
})
