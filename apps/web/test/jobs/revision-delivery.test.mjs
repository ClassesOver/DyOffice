import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {jobFixture} from '../helpers/jobs.mjs'
test('revision delivery is deployment scoped, leased and only acknowledged by its current token',async t=>{
  const f=await jobFixture(t),id=randomUUID(),hash='a'.repeat(64)
  await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query("INSERT INTO revision_outbox(id,deployment_id,owner_id,file_id,revision_id,event_type,payload) VALUES($1,$2,$3,$4,$5,'file.revision.committed','{}')",[id,f.deploymentId,f.alice.user.id,f.fileId,f.input.artifactId]))
  const take=async deployment=>(await f.workerPool.query('SELECT take_revision_delivery($1,$2,10000) AS value',[deployment,hash])).rows[0].value
  assert.equal(await take(randomUUID()),null)
  const delivery=await take(f.deploymentId);assert.deepEqual(delivery,{eventId:id,deliveryEpoch:1})
  assert.equal(await take(f.deploymentId),null)
  for(const pool of [f.authPool,f.businessPool])await assert.rejects(()=>pool.query('SELECT take_revision_delivery($1,$2,10000)',[f.deploymentId,hash]),{code:'42501'})
  const ack=async token=>(await f.workerPool.query('SELECT ack_revision_delivery($1,$2,1,$3,100) AS value',[f.deploymentId,id,token])).rows[0].value
  assert.equal(await ack('b'.repeat(64)),false);assert.equal(await ack(hash),true);assert.equal(await ack(hash),false)
  await new Promise(resolve=>setTimeout(resolve,120))
  assert.deepEqual(await take(f.deploymentId),{eventId:id,deliveryEpoch:2})
})

test('real Redis revision hints survive lost acknowledgement and broker queue loss without duplicate pending events',async t=>{
  const {createRevisionQueue,createRevisionDispatcher}=await import('../../server/src/outbox/dispatcher.ts')
  const f=await jobFixture(t,{workerPolicy:{deliveryLeaseMs:100,reconcileMs:100}}),id=randomUUID()
  await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},c=>c.query("INSERT INTO revision_outbox(id,deployment_id,owner_id,file_id,revision_id,event_type,payload) VALUES($1,$2,$3,$4,$5,'file.revision.committed','{\"private\":\"must not reach Redis\"}')",[id,f.deploymentId,f.alice.user.id,f.fileId,f.input.artifactId]))
  const queue=await createRevisionQueue({url:process.env.DYOFFICE_TEST_REDIS_URL,name:'dyoffice-revisions-'+randomUUID()})
  t.after(async()=>{await queue.queue.obliterate({force:true});await queue.close()})
  const dispatcher=createRevisionDispatcher({store:f.worker,queue})
  // SQL committed before a publisher existed. First publication loses its SQL ack.
  const orphan=await f.worker.takeRevisionDelivery();assert.equal(orphan.eventId,id)
  await queue.publish(orphan.eventId)
  await new Promise(resolve=>setTimeout(resolve,150))
  assert.equal(await dispatcher.runOnce(),true)
  assert.equal(await f.worker.ackRevisionDelivery(orphan),false)
  assert.equal(await queue.queue.getWaitingCount(),1)
  assert.deepEqual((await queue.queue.getJob(id)).data,{eventId:id})
  const published=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT published_at FROM revision_outbox WHERE id=$1',[id])).rows[0].published_at)
  assert.ok(published)
  // Delete only this test's broker queue, leaving canonical SQL untouched.
  await queue.queue.obliterate({force:true})
  assert.equal(await queue.queue.getJob(id),undefined)
  await new Promise(resolve=>setTimeout(resolve,150))
  assert.equal(await dispatcher.runOnce(),true)
  assert.deepEqual((await queue.queue.getJob(id)).data,{eventId:id})
  assert.equal(await queue.queue.getWaitingCount(),1)
})
