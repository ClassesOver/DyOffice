import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {jobFixture} from '../helpers/jobs.mjs'
import {loadMigrations} from '../../server/src/db/migration-manifest.ts'
import {provisionRuntimeRoles} from '../../server/src/db/roles.ts'
import {createIdentityStore} from '../../server/src/db/identity.ts'
import {createJobWorkerStore} from '../../server/src/modules/jobs/worker-store.ts'

async function fixture(t,leaseMs=1000) {
  const f=await jobFixture(t,{workerPolicy:{deliveryLeaseMs:leaseMs,reconcileMs:100}}),id=randomUUID()
  await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query("INSERT INTO revision_outbox(id,deployment_id,owner_id,file_id,revision_id,event_type,payload) VALUES($1,$2,$3,$4,$5,'file.revision.committed','{}')",[id,f.deploymentId,f.alice.user.id,f.fileId,f.input.artifactId]))
  return {...f,id}
}
async function wait(check,message) {
  const deadline=Date.now()+4000
  while(!await check()){assert.ok(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,10))}
}
test('revision ACK cannot revive its lease when it expires behind a real row lock',async t=>{
  const f=await fixture(t),delivery=await f.worker.takeRevisionDelivery(),held=await f.ownerPool.connect()
  const before=(await f.ownerPool.query('SELECT delivery_epoch,delivery_hash,delivery_until,published_at,next_delivery_at FROM revision_outbox WHERE id=$1',[f.id])).rows[0]
  let pending
  try {
    await held.query('BEGIN');await held.query('SELECT id FROM revision_outbox WHERE id=$1 FOR UPDATE',[f.id])
    pending=f.worker.ackRevisionDelivery(delivery)
    await wait(async()=>!!(await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock'",[f.database,f.names.worker])).rowCount,'ACK did not wait on actual row lock')
    await wait(async()=>(await f.ownerPool.query('SELECT delivery_until<=clock_timestamp() AS expired FROM revision_outbox WHERE id=$1',[f.id])).rows[0].expired,'Lease did not expire')
    await held.query('COMMIT')
    assert.equal(await pending,false,'expired ACK must be rejected after acquiring the lock')
    assert.deepEqual((await f.ownerPool.query('SELECT delivery_epoch,delivery_hash,delivery_until,published_at,next_delivery_at FROM revision_outbox WHERE id=$1',[f.id])).rows[0],before)
  }finally{await held.query('ROLLBACK');held.release();await pending?.catch(()=>{})}
})
test('concurrent revision acknowledgements accept the current capability exactly once',async t=>{
  const f=await fixture(t,10000),delivery=await f.worker.takeRevisionDelivery()
  assert.deepEqual((await Promise.all([f.worker.ackRevisionDelivery(delivery),f.worker.ackRevisionDelivery(delivery)])).sort(),[false,true])
  assert.ok((await f.ownerPool.query('SELECT published_at FROM revision_outbox WHERE id=$1',[f.id])).rows[0].published_at)
})
test('reclaimed revision delivery rejects old epoch and token without changing the new lease',async t=>{
  const f=await fixture(t,250),old=await f.worker.takeRevisionDelivery()
  await wait(async()=>(await f.ownerPool.query('SELECT delivery_until<=clock_timestamp() AS expired FROM revision_outbox WHERE id=$1',[f.id])).rows[0].expired,'Lease did not expire')
  const current=await createJobWorkerStore({pool:f.workerPool,deploymentId:f.deploymentId,deliveryLeaseMs:10000}).takeRevisionDelivery()
  assert.ok(current.deliveryEpoch>old.deliveryEpoch)
  assert.equal(await f.worker.ackRevisionDelivery(old),false)
  assert.equal(await f.worker.ackRevisionDelivery({...current,token:old.token}),false)
  assert.equal(await f.worker.ackRevisionDelivery(current),true)
})
test('forward ACK repair preserves the v14 ledger, function identity and runtime grants',async t=>{
  let ledger,authority
  const snapshot=async pool=>(await pool.query("SELECT oid,proowner,proacl,prosecdef,proconfig FROM pg_proc WHERE oid='ack_revision_delivery(uuid,uuid,bigint,text,integer)'::regprocedure")).rows[0]
  const f=await jobFixture(t,{async beforeMigrate(pool){
    await pool.query('CREATE TABLE identity_migrations(version integer PRIMARY KEY,sha256 text NOT NULL)')
    for(const migration of (await loadMigrations()).filter(m=>m.version<=14)) {
      await pool.query(migration.sql)
      await pool.query('INSERT INTO identity_migrations VALUES($1,$2)',[migration.version,migration.digest])
    }
    const owner=(await pool.query('SELECT current_user AS name')).rows[0].name
    await provisionRuntimeRoles(pool,{authRole:owner.replace(/_owner$/,'_auth'),businessRole:owner.replace(/_owner$/,'_business'),workerRole:owner.replace(/_owner$/,'_worker')})
    ledger=(await pool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
    authority=await snapshot(pool)
    await createIdentityStore(pool).migrate()
    // Check before the outer fixture re-provisions runtime grants, so that
    // provisioning cannot hide an ACL regression in the migration itself.
    assert.deepEqual(await snapshot(pool),authority)
  }})
  await f.ownerDb.assertCurrent()
  const current=(await f.ownerPool.query('SELECT * FROM identity_migrations ORDER BY version')).rows
  assert.deepEqual(current.slice(0,14),ledger)
  assert.equal(current.at(-1).version,15)
  assert.deepEqual(await snapshot(f.ownerPool),authority)
  assert.equal(await f.worker.takeRevisionDelivery(),null)
  for(const pool of [f.authPool,f.businessPool])await assert.rejects(()=>pool.query('SELECT ack_revision_delivery($1,$2,1,$3,100)',[f.deploymentId,randomUUID(),'a'.repeat(64)]),{code:'42501'})
})
