import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash,randomUUID } from 'node:crypto'
import { fileFixture,docxBytes } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import { createIdentityStore } from '../../server/src/db/identity.ts'
import { createAccountService } from '../../server/src/modules/auth/service.ts'
import { createPasswordService } from '../../server/src/modules/auth/passwords.ts'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'
import { createPrincipalTransactions } from '../../server/src/db/context.ts'
import { createFileService } from '../../server/src/modules/files/service.ts'
import { createLocalObjectStore } from '../../server/src/storage/local-dev.ts'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('migration 7 preserves v6 account, session, immutable versions, lease, receipt, outbox and quota',async t => {
  const directory = await mkdtemp(join(tmpdir(),'dyoffice-job-upgrade-'))
  t.after(() => rm(directory,{ recursive: true,force: true }))
  const objects = await createLocalObjectStore({ directory }), bytes = await docxBytes(), deploymentId = randomUUID(), base = randomUUID(), revision = randomUUID(), fileId = randomUUID(), uploadId = randomUUID(), editorId = randomUUID(), eventId = randomUUID()
  let signed,user,firstSix,reference
  const f = await fileFixture(t,{ objectStore: objects,worker: true,async beforeMigrate(pool) {
    await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
    for (const [index,file] of ['0001_identity.sql','0002_auth_sessions.sql','0003_account_lifecycle.sql','0004_rls.sql','0005_files.sql','0006_revisions.sql'].entries()) {
      const sql = await readFile(new URL('../../server/src/db/migrations/' + file,import.meta.url),'utf8')
      await pool.query(sql); await pool.query('INSERT INTO identity_migrations VALUES($1,$2)',[index+1,createHash('sha256').update(sql).digest('hex')])
    }
    firstSix = (await pool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
    const db = createIdentityStore(pool), passwords = await createPasswordService(), accounts = createAccountService({ db,passwords,deploymentId })
    user = await accounts.bootstrapAdmin({ username: 'old.owner',password })
    signed = await createSessionService({ db,accounts,deploymentId }).login('old.owner',password)
    const workspace = await db.transaction(async c => {
      await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[deploymentId,user.id])
      return (await c.query('SELECT id FROM workspaces WHERE deployment_id=$1 AND owner_id=$2',[deploymentId,user.id])).rows[0].id
    })
    const original = await objects.putImmutable(`${deploymentId}/${user.id}/objects/${base}`,bytes)
    reference = await objects.putImmutable(`${deploymentId}/${user.id}/objects/${revision}`,bytes)
    await db.transaction(async c => {
      await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[deploymentId,user.id])
      await c.query('INSERT INTO storage_accounts(deployment_id,owner_id,workspace_id,stored_bytes) VALUES($1,$2,$3,$4)',[deploymentId,user.id,workspace,bytes.length*2])
      await c.query("INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision) VALUES($1,$2,$3,$4,'before-jobs.docx','docx',$5)",[fileId,deploymentId,user.id,workspace,revision])
      await c.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)',[base,deploymentId,user.id,fileId,original.key,original.sha256,original.size])
      await c.query("INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size,source,parent_revision) VALUES($1,$2,$3,$4,$5,$6,$7,'save',$8)",[revision,deploymentId,user.id,fileId,reference.key,reference.sha256,reference.size,base])
      await c.query("INSERT INTO uploads(id,deployment_id,owner_id,workspace_id,file_id,revision_id,name,format,expected_size,auth_version,state,sha256,completed_file_id,expires_at,kind,base_revision,lease_epoch,editor_id,session_id) VALUES($1,$2,$3,$4,$5,$6,'before-jobs.docx','docx',$7,1,'committed',$8,$5,clock_timestamp()+interval '1 hour','revision',$9,7,$10,$11)",[uploadId,deploymentId,user.id,workspace,fileId,revision,bytes.length,reference.sha256,base,editorId,signed.sessionId])
      await c.query("INSERT INTO edit_leases VALUES($1,$2,$3,$4,1,$5,7,clock_timestamp()+interval '1 hour')",[deploymentId,user.id,fileId,signed.sessionId,editorId])
      const hash = createHash('sha256').update(JSON.stringify({ fileId,uploadId,baseRevision: base,leaseEpoch: 7,sourceCommandId: null })).digest('hex')
      await c.query("INSERT INTO revision_commits(deployment_id,owner_id,file_id,idempotency_key,request_hash,upload_id,revision_id,base_revision,lease_epoch) VALUES($1,$2,$3,'before_job_upgrade',$4,$5,$6,$7,7)",[deploymentId,user.id,fileId,hash,uploadId,revision,base])
      await c.query("INSERT INTO revision_outbox(id,deployment_id,owner_id,file_id,revision_id,event_type,payload) VALUES($1,$2,$3,$4,$5,'file.revision.committed',$6::jsonb)",[eventId,deploymentId,user.id,fileId,revision,JSON.stringify({ fileId,revision,baseRevision: base,source: 'save' })])
    })
  } })
  await f.ownerDb.assertCurrent()
  const versions = (await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
  assert.deepEqual(versions.slice(0,6),firstSix)
  assert.equal(versions[6].version,7)
  const accounts = createAccountService({ db: f.db,passwords: f.passwords,deploymentId })
  assert.equal((await createSessionService({ db: f.db,accounts,deploymentId }).authenticate(signed.token)).userId,user.id)
  const transactions = createPrincipalTransactions({ pool: f.businessPool,deploymentId }), files = createFileService({ transactions,objects })
  assert.equal((await files.openFile(signed.token,fileId)).file.revision,revision)
  assert.deepEqual(await objects.readVerified(reference),bytes)
  await transactions.withPrincipalTransaction({ kind: 'session',token: signed.token },async c => {
    assert.equal((await c.query('SELECT lease_epoch FROM edit_leases WHERE file_id=$1',[fileId])).rows[0].lease_epoch,'7')
    assert.equal((await c.query("SELECT revision_id FROM revision_commits WHERE idempotency_key='before_job_upgrade'")).rows[0].revision_id,revision)
    assert.equal((await c.query('SELECT published_at FROM revision_outbox WHERE id=$1',[eventId])).rows[0].published_at,null)
    assert.equal(Number((await c.query('SELECT stored_bytes FROM storage_accounts WHERE owner_id=$1',[user.id])).rows[0].stored_bytes),bytes.length*2)
  })
})
