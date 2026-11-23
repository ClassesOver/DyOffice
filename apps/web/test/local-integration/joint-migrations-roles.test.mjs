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

test('0054 backfills a pre-existing channel cursor and removes it with its source event',async t=>{
 const [deployment,owner,channel,file,event]=Array.from({length:5},()=>randomUUID())
 const f=await restrictedFixture(t,{seedAccounts:false,beforeMigrate:async pool=>{
  await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
  for(const m of migrations.slice(0,53)){
   await pool.query(m.sql)
   await pool.query('INSERT INTO identity_migrations VALUES($1,$2)',[m.version,m.digest])
  }
  await createIdentityStore(pool).transaction(async c=>{
   await c.query('INSERT INTO deployments(id) VALUES($1)',[deployment])
   await c.query("INSERT INTO users(id,deployment_id,username_normalized,status,password_hash) VALUES($1,$2,'old-owner','active','fixture')",[owner,deployment])
   await c.query('INSERT INTO assistant_channels(conversation_id,deployment_id,owner_id,file_id,sequence) VALUES($1,$2,$3,$4,7)',[channel,deployment,owner,file])
   await c.query("INSERT INTO assistant_events(event_id,deployment_id,owner_id,conversation_id,sequence,audience,type,payload) VALUES($1,$2,$3,$4,7,'office','task','{}')",[event,deployment,owner,channel])
  })
 }})
 await f.ownerDb.transaction(async c=>{
  await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[deployment,owner])
  const query='SELECT channel_sequence,channel_kind,payload FROM harness_task_events WHERE channel_event_id=$1'
  assert.deepEqual((await c.query(query,[event])).rows,[{channel_sequence:'7',channel_kind:'task',payload:null}])
  await c.query('DELETE FROM assistant_events WHERE event_id=$1',[event])
  assert.equal((await c.query(query,[event])).rowCount,0)
 })
})

test('pre-runtime claims, Codex checkpoints and cancellation flags survive conversion to compatibility views',async t=>{
 const [deployment,owner,workspace,file,revision,session,channel,task,claim]=Array.from({length:9},()=>randomUUID())
 const deadline=new Date(Date.now()+3600000)
 const principal=c=>c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[deployment,owner])
 const f=await restrictedFixture(t,{seedAccounts:false,worker:true,beforeMigrate:async pool=>{
  await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
  for(const m of migrations.slice(0,55)){
   await pool.query(m.sql)
   await pool.query('INSERT INTO identity_migrations VALUES($1,$2)',[m.version,m.digest])
  }
  await createIdentityStore(pool).transaction(async c=>{
   await principal(c)
   await c.query('INSERT INTO deployments(id) VALUES($1)',[deployment])
   await c.query("INSERT INTO users(id,deployment_id,username_normalized,status,password_hash) VALUES($1,$2,'runtime-owner','active','fixture')",[owner,deployment])
   await c.query('INSERT INTO workspaces(id,deployment_id,owner_id) VALUES($1,$2,$3)',[workspace,deployment,owner])
   await c.query("INSERT INTO files(id,deployment_id,owner_id,workspace_id,name,format,current_revision) VALUES($1,$2,$3,$4,'draft.docx','docx',$5)",[file,deployment,owner,workspace,revision])
   await c.query("INSERT INTO file_revisions(id,deployment_id,owner_id,file_id,object_key,sha256,size,source) VALUES($1,$2,$3,$4,$5,$6,1,'import')",[revision,deployment,owner,file,`${deployment}/${owner}/objects/${revision}`,'b'.repeat(64)])
   await c.query(`INSERT INTO harness_task_recovery(deployment_id,owner_id,session_id,file_id,turn_id,state,status_payload,checkpoint,lease_until,expires_at)
    VALUES($1,$2,$3,$4,'existing','cancel_requested','{}','saved checkpoint',$5,$5)`,[deployment,owner,session,file,deadline])
   await c.query('INSERT INTO assistant_channels(conversation_id,deployment_id,owner_id,file_id) VALUES($1,$2,$3,$4)',[channel,deployment,owner,file])
   await c.query(`INSERT INTO assistant_tasks(task_id,deployment_id,owner_id,conversation_id,root_task_id,depth,sender,recipient,instruction,state,execution,deadline_at)
    VALUES($1,$2,$3,$4,$1,0,'peer','office','prior task','running','saved-revision',$5)`,[task,deployment,owner,channel,deadline])
   await c.query(`INSERT INTO assistant_background_queue(task_id,deployment_id,owner_id,conversation_id,claim_id,claim_hash,credential,lease_until)
    VALUES($1,$2,$3,$4,$5,'prior claim hash','prior credential',$6)`,[task,deployment,owner,channel,claim,deadline])
  })
 }})
 await createIdentityStore(f.businessPool).transaction(async c=>{
  await principal(c)
  assert.deepEqual((await c.query('SELECT state,cancel_requested,lease_until FROM task_runtime ORDER BY state')).rows,[
   {state:'cancel_requested',cancel_requested:true,lease_until:deadline},{state:'running',cancel_requested:false,lease_until:deadline},
  ])
  assert.deepEqual((await c.query('SELECT checkpoint FROM harness_task_recovery')).rows,[{checkpoint:'saved checkpoint'}])
  assert.deepEqual((await c.query('SELECT claim_id,claim_hash,credential,lease_until FROM assistant_background_queue')).rows,[
   {claim_id:claim,claim_hash:'prior claim hash',credential:'prior credential',lease_until:deadline},
  ])
  for(const view of ['assistant_tasks','harness_task_recovery','assistant_background_queue']){
   const {rows:[flags]}=await c.query("SELECT relkind,has_table_privilege(current_user,oid,'SELECT') AS readable,has_any_column_privilege(current_user,oid,'UPDATE') AS writable FROM pg_class WHERE oid=$1::regclass",[view])
   assert.deepEqual(flags,{relkind:'v',readable:true,writable:false})
  }
  await c.query("SELECT set_config('dyoffice.user_id',$1,true)",[randomUUID()])
  assert.equal((await c.query('SELECT * FROM task_runtime')).rowCount,0)
 })
})
