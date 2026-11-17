import {test} from 'node:test'
import assert from 'node:assert/strict'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {loadMigrations} from '../../server/src/db/migration-manifest.ts'
import {assertRuntimePool} from '../../server/src/db/roles.ts'
const migrations=await loadMigrations()
test('fresh28, repeat migrate and all three restricted roles retain combined boundaries', async t=>{
 const f=await restrictedFixture(t,{worker:true});assert.equal(migrations.length,28)
 await f.ownerDb.assertCurrent();await f.ownerDb.migrate();await f.ownerDb.assertCurrent()
 for(const kind of ['auth','business','worker']) await assertRuntimePool(f[kind+'Pool'],kind)
 const flags=(await f.ownerPool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname = ANY($1)",[['user_skills','data_sources','data_source_credentials','workspace_source_results']])).rows
 assert.equal(flags.length,4);for(const x of flags) assert.ok(x.relrowsecurity&&x.relforcerowsecurity)
 await assert.rejects(f.workerPool.query('SELECT * FROM data_sources'),e=>e.code==='42501')
 await assert.rejects(f.businessPool.query('UPDATE workspace_source_results SET snapshot=snapshot'),e=>e.code==='42501')
})
test('existing24 upgrades append-only preserving every existing digest',async t=>{
 let before
 const f=await restrictedFixture(t,{seedAccounts:false,beforeMigrate:async p=>{
 await p.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
 for(const m of migrations.slice(0,24)){await p.query(m.sql);await p.query('INSERT INTO identity_migrations VALUES($1,$2)',[m.version,m.digest])}
 before=(await p.query('SELECT * FROM identity_migrations ORDER BY version')).rows
 }})
 const after=(await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
 assert.deepEqual(after.slice(0,24),before);assert.equal(after.length,28);await f.ownerDb.migrate();await f.ownerDb.assertCurrent()
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
