import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {createPrincipalTransactions} from '../../server/src/db/context.ts'
import {createIdentityStore} from '../../server/src/db/identity.ts'
import {tokenHash} from '../../server/src/modules/auth/sessions.ts'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {loadMigrations} from '../../server/src/db/migration-manifest.ts'
import {assertRuntimePool} from '../../server/src/db/roles.ts'
const migrations=await loadMigrations()
const expectedLedger=migrations.map(({version,digest})=>({version,sha256:digest}))
test('fresh manifest, repeat migrate and all three restricted roles retain combined boundaries', async t=>{
 const f=await restrictedFixture(t,{worker:true})
 await f.ownerDb.assertCurrent();await f.ownerDb.migrate();await f.ownerDb.assertCurrent()
 assert.deepEqual((await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows,expectedLedger)
 for(const kind of ['auth','business','worker']) await assertRuntimePool(f[kind+'Pool'],kind)
 const flags=(await f.ownerPool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname = ANY($1)",[['user_skills','data_sources','data_source_credentials','workspace_source_results']])).rows
 assert.equal(flags.length,4);for(const x of flags) assert.ok(x.relrowsecurity&&x.relforcerowsecurity)
 await assert.rejects(f.workerPool.query('SELECT * FROM data_sources'),e=>e.code==='42501')
 await assert.rejects(f.businessPool.query('UPDATE workspace_source_results SET snapshot=snapshot'),e=>e.code==='42501')
})
for (const prior of [24,28]) test(`existing${prior} upgrades append-only preserving every existing digest`,async t=>{
 let before
 const f=await restrictedFixture(t,{seedAccounts:false,beforeMigrate:async p=>{
 await p.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
 for(const m of migrations.slice(0,prior)){await p.query(m.sql);await p.query('INSERT INTO identity_migrations VALUES($1,$2)',[m.version,m.digest])}
 before=(await p.query('SELECT * FROM identity_migrations ORDER BY version')).rows
 }})
 const after=(await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
 assert.deepEqual(after.slice(0,prior),before);assert.deepEqual(after,expectedLedger);await f.ownerDb.migrate();await f.ownerDb.assertCurrent()
})
test('the 0049 PDF edit grant and its saved revision remain authorized after 0050', async t => {
 const [deploymentId,ownerId,workspaceId,fileId,revision,resultRevision,sessionId,grantId] = Array.from({length:8},()=>randomUUID())
 const token = randomBytes(32).toString('base64url')
 const f = await restrictedFixture(t,{seedAccounts:false,beforeMigrate:async pool=>{
  await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
  for(const m of migrations.slice(0,49)){
    await pool.query(m.sql)
    await pool.query('INSERT INTO identity_migrations VALUES($1,$2)',[m.version,m.digest])
  }
  // Seed the v49 durable grant and revision records, with no document bytes.
  await createIdentityStore(pool).transaction(async c=>{
    await c.query('INSERT INTO deployments(id) VALUES($1)',[deploymentId])
    await c.query("INSERT INTO users(id,deployment_id,username_normalized,status,password_hash) VALUES($1,$2,'prior-owner','active','test-only')",[ownerId,deploymentId])
    await c.query("INSERT INTO user_roles(deployment_id,user_id,role) VALUES($1,$2,'personal')",[deploymentId,ownerId])
    await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[deploymentId,ownerId])
    await c.query('INSERT INTO workspaces(id,deployment_id,owner_id) VALUES($1,$2,$3)',[workspaceId,deploymentId,ownerId])
    await c.query("INSERT INTO sessions(id,deployment_id,user_id,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,1,clock_timestamp()+interval '1 hour')",
      [sessionId,deploymentId,ownerId,tokenHash(randomBytes(32).toString('base64url'))])
    await c.query("INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision) VALUES($1,$2,$3,$4,'old.pdf','pdf',$5)",
      [fileId,deploymentId,ownerId,workspaceId,resultRevision])
    for(const [id,source,parent] of [[revision,'import',null],[resultRevision,'save',revision]]) {
      await c.query('INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size,source,parent_revision) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)',
        [id,deploymentId,ownerId,fileId,`${deploymentId}/${ownerId}/objects/${id}`,'a'.repeat(64),source,parent])
    }
    await c.query("INSERT INTO mcp_read_grants(id,deployment_id,owner_id,session_id,file_id,revision_id,token_hash,expires_at,approved_pdf_pages,approved_pdf_degrees,committed_pdf_revision) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 hour',ARRAY[2,5],90,$8)",
      [grantId,deploymentId,ownerId,sessionId,fileId,revision,tokenHash(token),resultRevision])
  })
 }})
 const transactions=createPrincipalTransactions({pool:f.businessPool,deploymentId})
 const credential={kind:'external-token',token}
 assert.deepEqual(await transactions.inspectMcpReadScope(credential),
   {id:grantId,fileId,revision,approval:{kind:'pdf.rotate',pages:[2,5],degrees:90},resultRevision})
 assert.equal(await transactions.withMcpReadTransaction(credential,{fileId,revision:resultRevision},async (_c,p)=>p.userId),ownerId)
 await assert.rejects(()=>transactions.withMcpReadTransaction(credential,{fileId,revision:randomUUID()},async()=>assert.fail('wrong revision')), {statusCode:404})
})
test('divergent PR132 ledger rejects without modifying history',async t=>{
 let before,probe
 await assert.rejects(restrictedFixture(t,{seedAccounts:false,beforeMigrate:async p=>{
 probe=p;await p.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
 for(const m of migrations.slice(0,22)){await p.query(m.sql);await p.query('INSERT INTO identity_migrations VALUES($1,$2)',[m.version,m.digest])}
 for(let i=24;i<28;i++){const m=migrations[i];await p.query(m.sql);await p.query('INSERT INTO identity_migrations VALUES($1,$2)',[i-1,m.digest])}
 before=(await p.query('SELECT * FROM identity_migrations ORDER BY version')).rows
 }}),/checksum mismatch/)
 assert.deepEqual((await probe.query('SELECT * FROM identity_migrations ORDER BY version')).rows,before)
})
