import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { fileFixture,importFile } from '../helpers/files.mjs'
import { sandboxFixture } from '../helpers/native-sandbox.mjs'
import { createXlsxNativeWorker } from '../../worker/src/native/xlsx.ts'
import { createJobService } from '../../server/src/modules/jobs/service.ts'
import { createJobWorkerStore } from '../../server/src/modules/jobs/worker-store.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
import { createJobQueue,createJobDispatcher } from '../../server/src/outbox/dispatcher.ts'
const exec = promisify(execFile)
const gate = () => { let resolve; const promise = new Promise(r => { resolve=r }); return { promise,resolve } }
async function fixture(t,{ paused = false,leaseMs = 3000 } = {}) {
  const { createXlsxJobExecutor } = await import('../../worker/src/jobs/xlsx.ts')
  const f = await fileFixture(t,{ worker: true })
  const original = await readFile(new URL('../../../shell/build/shell-new/blank.xlsx',import.meta.url))
  const zip = await JSZip.loadAsync(original)
  zip.file('customXml/native-job-preserve.xml','<private>Retain this exact original part</private>')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' }), file = await importFile(f,f.alice.token,bytes,'native-job.xlsx')
  const jobs = createJobService({ transactions: f.transactions,enabledTypes: ['xlsx.roundtrip'] })
  const store = createJobWorkerStore({ pool: f.workerPool,deploymentId: f.deploymentId,leaseMs })
  const leases = createLeaseService({ transactions: f.transactions })
  const revisions = createRevisionService({ transactions: f.transactions,objects: f.objects,files: f.files })
  const sandbox = await sandboxFixture('native'), started = gate(), resume = gate()
  t.after(() => resume.resolve())
  const native = createXlsxNativeWorker(paused ? { run: (input,execute,options) => sandbox.run(input,async session => { started.resolve(); await resume.promise; return execute(session) },options) } : sandbox)
  const executor = createXlsxJobExecutor({ store,files: f.files,leases,revisions,native,heartbeatMs: 250 })
  const job = await jobs.enqueueJob(f.alice.token,'xlsx.roundtrip',{ artifactId: file.file.revision },randomUUID())
  return { ...f,bytes,file: file.file,jobs,store,leases,revisions,executor,job,started,resume }
}
async function metadata(f) {
  return f.ownerDb.transaction(async c => {
    await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
    return (await c.query('SELECT (SELECT state FROM native_jobs WHERE id=$1) AS state,(SELECT error_code FROM native_jobs WHERE id=$1) AS error,(SELECT count(*)::int FROM file_revisions WHERE file_id=$2) AS versions,(SELECT count(*)::int FROM revision_commits WHERE file_id=$2) AS receipts,(SELECT count(*)::int FROM revision_outbox WHERE file_id=$2) AS events',[f.job.id,f.file.fileId])).rows[0]
  })
}
async function noContainers() {
  assert.equal((await exec('/usr/bin/docker',['ps','-aq','--filter','label=dyoffice.sandbox=true'])).stdout.trim(),'')
}
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise,new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('Native controller did not finish')),12_000) })]) }
  finally { clearTimeout(timer) }
}
async function preserved(f,result) {
  const output = await f.files.readFile(f.alice.token,f.file.fileId,result.revision)
  const before = await JSZip.loadAsync(f.bytes,{ checkCRC32: true }), after = await JSZip.loadAsync(output,{ checkCRC32: true })
  const parts = z => Object.keys(z.files).filter(n => !z.files[n].dir).sort()
  assert.deepEqual(parts(after),parts(before))
  for (const name of parts(before)) assert.deepEqual(await after.file(name).async('nodebuffer'),await before.file(name).async('nodebuffer'),name)
}
test('real native XLSX output traverses validation and atomically commits one version and successful job',{ timeout: 30_000 },async t => {
  const f = await fixture(t), claim = await f.store.claim(f.job.id)
  const result = await f.executor.execute(claim)
  assert.deepEqual(await metadata(f),{ state: 'succeeded',error: null,versions: 2,receipts: 1,events: 1 })
  assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).resultRevision,result.revision)
  assert.equal((await f.leases.getLease(f.alice.token,f.file.fileId)).active,false)
  await preserved(f,result)
  assert.equal(await f.store.claim(f.job.id),null)
  await noContainers()
})
test('heartbeat renews both SQL claim and edit lease while a real Rust container remains active',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true,leaseMs: 2000 }), claim = await f.store.claim(f.job.id)
  const finished = f.executor.execute(claim); void finished.catch(() => {})
  await bounded(f.started.promise)
  await new Promise(resolve => setTimeout(resolve,2500))
  assert.equal((await f.jobs.getJob(f.alice.token,f.job.id)).state,'running')
  assert.equal(await f.store.claim(f.job.id),null,'Heartbeat must prevent a second claimant')
  assert.equal((await f.leases.getLease(f.alice.token,f.file.fileId)).active,true)
  f.resume.resolve(); const result = await bounded(finished)
  await preserved(f,result); await noContainers()
})
test('database cancellation kills an already active Rust container and publishes no output',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true }), claim = await f.store.claim(f.job.id)
  const finished = f.executor.execute(claim); void finished.catch(() => {})
  await bounded(f.started.promise)
  await f.jobs.cancelJob(f.alice.token,f.job.id)
  await assert.rejects(() => bounded(finished),{ code: 'AUTHORITY_LOST' })
  f.resume.resolve()
  assert.deepEqual(await metadata(f),{ state: 'cancelled',error: 'CANCELLED',versions: 1,receipts: 0,events: 0 })
  assert.equal((await f.leases.getLease(f.alice.token,f.file.fileId)).active,false)
  await noContainers()
})
test('session revocation aborts an active native container without holding identity locks across native execution',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true }), claim = await f.store.claim(f.job.id)
  const finished = f.executor.execute(claim); void finished.catch(() => {})
  await bounded(f.started.promise)
  await bounded(f.sessions.revoke(f.alice.token,f.alice.sessionId))
  await assert.rejects(() => bounded(finished),{ code: 'AUTHORITY_LOST' }); f.resume.resolve()
  assert.deepEqual(await metadata(f),{ state: 'cancelled',error: 'AUTH_REVOKED',versions: 1,receipts: 0,events: 0 })
  await noContainers()
})
test('lost SQL claim kills the old native process; only the reclaimed epoch can commit output',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true }), first = await f.store.claim(f.job.id)
  const finished = f.executor.execute(first); void finished.catch(() => {})
  await bounded(f.started.promise)
  await f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.id]))
  const next = await f.store.claim(f.job.id)
  assert.ok(next.epoch>first.epoch)
  await assert.rejects(() => bounded(finished),{ code: 'AUTHORITY_LOST' }); f.resume.resolve(); await noContainers()
  const result = await bounded(f.executor.execute(next))
  await preserved(f,result)
  assert.deepEqual(await metadata(f),{ state: 'succeeded',error: null,versions: 2,receipts: 1,events: 1 })
  await noContainers()
})
test('real BullMQ delivery and duplicate hints run the actual Rust writer and retain one durable output',{ timeout: 30_000 },async t => {
  const f = await fixture(t), url = process.env.DYOFFICE_TEST_REDIS_URL
  assert.ok(url,'Dedicated disposable Redis required')
  const queue = await createJobQueue({ url,name: 'dyoffice-native-test-' + randomUUID() })
  f.cleanup.unshift(async () => { try { await queue.queue.obliterate({ force: true }) } finally { await queue.close() } })
  const dispatcher = createJobDispatcher({ store: f.store,queue })
  let executions = 0
  const consumer = queue.consume(f.store,async claim => { executions++; await f.executor.execute(claim) })
  f.cleanup.unshift(() => consumer.close(true))
  const complete = gate(); consumer.on('completed',() => complete.resolve())
  await consumer.waitUntilReady(); await dispatcher.runOnce(); await bounded(complete.promise)
  const again = gate(); consumer.once('completed',() => again.resolve())
  await queue.enqueueHint({ jobId: f.job.id,deliveryEpoch: 999 }); await bounded(again.promise)
  assert.equal(executions,1)
  const stored = await f.jobs.getJob(f.alice.token,f.job.id)
  assert.equal(stored.state,'succeeded'); await preserved(f,{ revision: stored.resultRevision })
  assert.deepEqual(await metadata(f),{ state: 'succeeded',error: null,versions: 2,receipts: 1,events: 1 })
  await noContainers()
})

test('controller shutdown aborts native work, releases its edit lease and leaves a resumable SQL job',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true }), first = await f.store.claim(f.job.id), stop = new AbortController()
  const finished = f.executor.execute(first,{ signal: stop.signal }); void finished.catch(() => {})
  await bounded(f.started.promise); stop.abort()
  await assert.rejects(() => bounded(finished),{ code: 'ABORTED' }); f.resume.resolve()
  assert.deepEqual(await metadata(f),{ state: 'queued',error: 'WORKER_FAILED',versions: 1,receipts: 0,events: 0 })
  assert.equal((await f.leases.getLease(f.alice.token,f.file.fileId)).active,false)
  await noContainers()
  const next = await f.store.claim(f.job.id)
  assert.ok(next.epoch>first.epoch)
  await preserved(f,await f.executor.execute(next))
  assert.deepEqual(await metadata(f),{ state: 'succeeded',error: null,versions: 2,receipts: 1,events: 1 })
  await noContainers()
})
