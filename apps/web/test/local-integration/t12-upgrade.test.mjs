import test from 'node:test'
import assert from 'node:assert/strict'
import { restrictedFixture } from '../helpers/restricted.mjs'
import { loadMigrations } from '../../server/src/db/migration-manifest.ts'

const protectedFunctions=['ack_revision_delivery(uuid,uuid,bigint,text,integer)','guard_file_lifecycle()','lock_business_session(uuid,text,bigint)']
async function functions(pool){return (await pool.query('SELECT oid,proowner,proacl,prosrc,prosecdef,proconfig FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid',[protectedFunctions])).rows}
test('T12 upgrades v17 ledger without rewriting ACK purge or session authority',async t=>{
 const migrations=await loadMigrations();let ledger,before
 const f=await restrictedFixture(t,{worker:true,beforeMigrate:async pool=>{
  await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
  for(const m of migrations.filter(m=>m.version<=17)){await pool.query(m.sql);await pool.query('INSERT INTO identity_migrations VALUES($1,$2)',[m.version,m.digest])}
  const owner=(await pool.query('SELECT current_user AS name')).rows[0].name
  await pool.query('GRANT EXECUTE ON FUNCTION ack_revision_delivery(uuid,uuid,bigint,text,integer) TO '+owner.replace(/_owner$/,'_worker'))
  ledger=(await pool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
  before=await functions(pool)
 }})
 const after=(await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
 assert.deepEqual(after.slice(0,17),ledger)
 assert.deepEqual(after.map(m=>m.version),Array.from({length:migrations.length},(_,i)=>i+1))
 // Runtime provisioning reasserts grants; function definitions and identities must stay intact.
 const current=await functions(f.ownerPool)
 for(let i=0;i<before.length;i++)for(const key of ['oid','proowner','prosrc','prosecdef','proconfig'])assert.deepEqual(current[i][key],before[i][key])
 assert.equal((await f.workerPool.query("SELECT has_function_privilege(current_user,'ack_revision_delivery(uuid,uuid,bigint,text,integer)','EXECUTE') AS allowed")).rows[0].allowed,true)
 await f.ownerDb.migrate()
 assert.deepEqual((await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows,after)
})
