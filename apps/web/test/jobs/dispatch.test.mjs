import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jobFixture } from '../helpers/jobs.mjs'
import { randomUUID } from 'node:crypto'

async function fixture(t) {
  const { createJobQueue,createJobDispatcher } = await import('../../server/src/outbox/dispatcher.ts')
  const f = await jobFixture(t)
  const url = process.env.DYOFFICE_TEST_REDIS_URL
  assert.ok(url,'Dedicated disposable loopback Redis required')
  assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname))
  const queue = await createJobQueue({ url,name: 'dyoffice-test-' + randomUUID() })
  f.cleanup.push(async () => { try { await queue.queue.obliterate({ force: true }) } finally { await queue.close() } })
  const dispatcher = createJobDispatcher({ store: f.worker,queue })
  const job = await f.jobs.enqueueJob(f.alice.token,'docx.roundtrip',f.input,randomUUID())
  return { ...f,queue,dispatcher,job }
}
async function due(f) { await f.ownerPool.query("UPDATE job_outbox SET next_delivery_at=clock_timestamp()-interval '1 second',lease_until=CASE WHEN lease_hash IS NULL THEN NULL ELSE clock_timestamp()-interval '1 second' END WHERE job_id=$1",[f.job.id]) }
async function consume(f,execute) {
  const worker = f.queue.consume(f.worker,execute)
  worker.observedDrain = new Promise(resolve => worker.once('drained',resolve))
  f.cleanup.unshift(() => worker.close(true))
  await worker.waitUntilReady()
  return worker
}
async function terminal(f) {
  const deadline = Date.now()+8000
  for (;;) {
    const job = await f.jobs.getJob(f.alice.token,f.job.id)
    if (job.state === 'failed') return job
    assert.ok(Date.now()<deadline,'Real queue worker did not consume the durable job')
    await new Promise(resolve => setTimeout(resolve,20))
  }
}
test('a dispatcher crash before queue delivery loses no PostgreSQL job and sends only opaque IDs',async t => {
  const f = await fixture(t), held = await f.worker.takeDelivery()
  assert.equal(held.jobId,f.job.id)
  assert.equal(await f.dispatcher.runOnce(),false)
  await due(f)
  assert.equal(await f.dispatcher.runOnce(),true)
  const waiting = await f.queue.queue.getJobs(['waiting'])
  assert.equal(waiting.length,1)
  assert.deepEqual(Object.keys(waiting[0].data).sort(),['deliveryEpoch','jobId'])
  assert.equal(waiting[0].data.jobId,f.job.id)
  assert.equal(await f.worker.ackDelivery(held),false)
})
test('Redis queue loss is repaired from already acknowledged PostgreSQL state',async t => {
  const f = await fixture(t)
  await f.dispatcher.runOnce()
  await f.queue.queue.obliterate({ force: true })
  assert.equal(await f.queue.queue.getWaitingCount(),0)
  assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'queued')
  await due(f); await f.dispatcher.runOnce()
  let executions = 0
  await consume(f,async claim => { executions++; await f.worker.fail(claim,'NATIVE_FAILED',false) })
  assert.equal((await terminal(f)).attempts,1)
  assert.equal(executions,1)
})
test('delivery followed by lost acknowledgement may duplicate hints but not the PostgreSQL claim',async t => {
  const f = await fixture(t), { createJobDispatcher } = await import('../../server/src/outbox/dispatcher.ts')
  const crashed = createJobDispatcher({ store: f.worker,queue: { async enqueueHint(hint) { await f.queue.enqueueHint(hint); throw new Error('controlled crash after real Redis add') } } })
  await assert.rejects(() => crashed.runOnce(),/controlled crash/)
  await due(f); await f.dispatcher.runOnce()
  assert.equal(await f.queue.queue.getWaitingCount(),2)
  let executions = 0
  const worker = await consume(f,async claim => { executions++; await f.worker.fail(claim,'WORKER_FAILED',false) })
  await terminal(f)
  await worker.observedDrain
  await worker.close()
  assert.equal(await f.queue.queue.getCompletedCount(),2)
  assert.equal(executions,1)
})
test('producer reconnects after a real Redis connection is killed and SQL can deliver again', { timeout: 15_000 },async t => {
  const f = await fixture(t), client = await f.queue.queue.client
  const originalId = await client.call('CLIENT','ID')
  await client.call('CLIENT','KILL','ID',originalId,'SKIPME','NO').catch(() => {})
  const deadline = Date.now()+4000
  let reconnected = false
  while (Date.now()<deadline) {
    try { if (client.status === 'ready' && await client.call('CLIENT','ID') !== originalId) { reconnected = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve,20))
  }
  assert.ok(reconnected,'Producer connection never recovered')
  assert.equal(await f.dispatcher.runOnce(),true)
  assert.equal(await f.queue.queue.getWaitingCount(),1)
})
test('a forged queue message cannot add identity, paths or commands to an authorized job',async t => {
  const f = await fixture(t)
  await f.queue.queue.add('forged',{ jobId: f.job.id,deliveryEpoch: 1,command: 'unexpected' })
  let executions = 0
  const worker = await consume(f,async () => { executions++ })
  await worker.observedDrain
  await worker.close()
  assert.equal(await f.queue.queue.getFailedCount(),1)
  assert.equal(executions,0)
  assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).attempts,0)
})
test('a standard loopback Redis URI without a path selects the default database',async t => {
  const { createJobQueue } = await import('../../server/src/outbox/dispatcher.ts')
  const url = new URL(process.env.DYOFFICE_TEST_REDIS_URL)
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname))
  url.pathname = ''
  const queue = await createJobQueue({ url: url.toString(),name: 'dyoffice-test-' + randomUUID() })
  t.after(async () => { try { await queue.queue.obliterate({ force: true }) } finally { await queue.close() } })
  assert.equal((await queue.queue.client).options.db,0)
  await queue.enqueueHint({ jobId: randomUUID(),deliveryEpoch: 1 })
  assert.equal(await queue.queue.getWaitingCount(),1)
})
