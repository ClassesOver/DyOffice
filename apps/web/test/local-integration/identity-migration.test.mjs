import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { createIdentityStore } from '../../server/src/db/identity.ts'
import { createPasswordService } from '../../server/src/modules/auth/passwords.ts'
import { createAccountService } from '../../server/src/modules/auth/service.ts'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'

test('identity migration upgrades an existing v1 account/session and rejects checksum drift without losing credentials', async t => {
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
  const oldToken = randomBytes(32).toString('base64url')
  await pool.query("INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,1,clock_timestamp()+interval '1 hour')", [randomUUID(), deploymentId, user.id, createHash('sha256').update(oldToken).digest('hex')])
  await db.migrate()
  await db.assertCurrent()
  assert.equal((await accounts.verifyCredentials('owner', password)).userId, user.id)
  const sessions = createSessionService({ db, accounts, deploymentId })
  assert.equal((await sessions.authenticate(oldToken)).userId, user.id)
  assert.equal((await sessions.authenticate((await sessions.login('owner', password)).token)).userId, user.id)
  await pool.query("UPDATE identity_migrations SET sha256='tampered-test-checksum' WHERE version=2")
  await assert.rejects(() => db.migrate(), /checksum/)
  await assert.rejects(() => db.assertCurrent(), /not current/)
  assert.equal((await accounts.verifyCredentials('owner', password)).userId, user.id)
})

test('revision migration preserves a v5 imported file, immutable object, quota and existing session', async t => {
  const connectionString = process.env.DYOFFICE_TEST_DATABASE_URL
  assert.ok(connectionString,'Disposable PostgreSQL required')
  assert.match(new URL(connectionString).pathname,/^\/dyoffice_test(?:_[a-z0-9_]+)?$/)
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { createLocalObjectStore } = await import('../../server/src/storage/local-dev.ts')
  const schema = 'revision_upgrade_' + randomUUID().replaceAll('-',''), admin = new Pool({ connectionString })
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-v5-upgrade-'))
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new Pool({ connectionString, options: '-c search_path=' + schema })
  t.after(async () => {
    try { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE') }
    finally { await admin.end(); await rm(directory,{ recursive: true, force: true }) }
  })
  await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
  for (const [index,file] of ['0001_identity.sql','0002_auth_sessions.sql','0003_account_lifecycle.sql','0004_rls.sql','0005_files.sql'].entries()) {
    const sql = await readFile(new URL('../../server/src/db/migrations/' + file,import.meta.url),'utf8')
    await pool.query(sql)
    await pool.query('INSERT INTO identity_migrations VALUES($1,$2)',[index+1,createHash('sha256').update(sql).digest('hex')])
  }
  const db = createIdentityStore(pool), deploymentId = randomUUID(), passwords = await createPasswordService()
  const accounts = createAccountService({ db, passwords, deploymentId }), password = 'upgrade original documents stay intact 7531'
  const user = await accounts.bootstrapAdmin({ username: 'owner', password }), sessions = createSessionService({ db, accounts, deploymentId })
  const signed = await sessions.login('owner',password), fileId = randomUUID(), revision = randomUUID(), uploadId = randomUUID()
  const objects = await createLocalObjectStore({ directory }), bytes = await readFile(new URL('../../../../apps/shell/build/shell-new/blank.xlsx',import.meta.url))
  const reference = await objects.putImmutable(`${deploymentId}/${user.id}/objects/${revision}`,bytes)
  const workspace = (await pool.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2',[deploymentId,user.id])).rows[0].id
  await db.transaction(async connection => {
    await connection.query('INSERT INTO storage_accounts(deployment_id,owner_id,workspace_id,stored_bytes) VALUES($1,$2,$3,$4)',[deploymentId,user.id,workspace,bytes.length])
    await connection.query("INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision) VALUES($1,$2,$3,$4,'before.xlsx','xlsx',$5)",[fileId,deploymentId,user.id,workspace,revision])
    await connection.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)',[revision,deploymentId,user.id,fileId,reference.key,reference.sha256,reference.size])
    await connection.query("INSERT INTO uploads(id,deployment_id,owner_id,workspace_id,file_id,revision_id,name,format,expected_size,auth_version,state,sha256,completed_file_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,'before.xlsx','xlsx',$7,1,'committed',$8,$5,clock_timestamp()+interval '1 hour')",[uploadId,deploymentId,user.id,workspace,fileId,revision,bytes.length,reference.sha256])
  })
  await db.migrate(); await db.assertCurrent()
  assert.equal((await sessions.authenticate(signed.token)).userId,user.id)
  assert.deepEqual((await pool.query('SELECT kind,base_revision,lease_epoch,session_id FROM uploads WHERE id=$1',[uploadId])).rows[0],{ kind: 'import', base_revision: null, lease_epoch: null, session_id: null })
  assert.equal((await pool.query('SELECT current_revision FROM files WHERE id=$1',[fileId])).rows[0].current_revision,revision)
  assert.equal(Number((await pool.query('SELECT stored_bytes FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2',[deploymentId,user.id])).rows[0].stored_bytes),bytes.length)
  assert.deepEqual(await objects.readVerified(reference),bytes)
})
