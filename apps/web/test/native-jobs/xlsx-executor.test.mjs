import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { fileFixture,importFile } from '../helpers/files.mjs'
import { s3Fixture } from '../helpers/s3.mjs'
import { sandboxFixture } from '../helpers/native-sandbox.mjs'
import { createXlsxNativeWorker } from '../../worker/src/native/xlsx.ts'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { restrictedOrigin } from '../helpers/restricted.mjs'
import { createJobService } from '../../server/src/modules/jobs/service.ts'
import { createJobWorkerStore } from '../../server/src/modules/jobs/worker-store.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
import { createJobQueue,createJobDispatcher,createRevisionQueue } from '../../server/src/outbox/dispatcher.ts'
const exec = promisify(execFile)
const gate = () => { let resolve; const promise = new Promise(r => { resolve=r }); return { promise,resolve } }
async function fixture(t,{ paused = false,leaseMs = 3000,objectStore } = {}) {
  const { createXlsxJobExecutor } = await import('../../worker/src/jobs/xlsx.ts')
  const f = await fileFixture(t,{ worker: true,nativeJobs: true,objectStore })
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
  const csrf = createCsrfService({ db: f.db,deploymentId: f.deploymentId,origin: restrictedOrigin,key: f.csrfKey })
  const accepted = await f.app.inject({ method: 'POST',url: '/api/v1/jobs',headers: { cookie: '__Host-dyoffice-session=' + f.alice.token,origin: restrictedOrigin,'x-csrf-token': csrf.sessionToken(f.alice.token) },payload: { type: 'xlsx.roundtrip',input: { artifactId: file.file.revision },idempotencyKey: randomUUID() } })
  assert.equal(accepted.statusCode,202)
  const job = accepted.json()
  return { ...f,bytes,file: file.file,jobs,store,leases,revisions,executor,job,started,resume }
}
async function metadata(f) {
  return f.ownerDb.transaction(async c => {
    await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
    return (await c.query('SELECT (SELECT state FROM native_jobs WHERE id=$1) AS state,(SELECT error_code FROM native_jobs WHERE id=$1) AS error,(SELECT count(*)::int FROM file_revisions WHERE file_id=$2) AS versions,(SELECT count(*)::int FROM revision_commits WHERE file_id=$2) AS receipts,(SELECT count(*)::int FROM revision_outbox WHERE file_id=$2) AS events',[f.job.id,f.file.fileId])).rows[0]
  })
}
async function noNativeServices() {
  const output=(await exec('/usr/bin/systemctl',['list-units','--all','--plain','--no-legend','--no-pager','dyoffice-*.service'])).stdout
  const taskUnits=output.split('\n').map(line=>line.trim().split(/\s+/)[0]).filter(name=>/^dyoffice-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.service$/.test(name))
  assert.deepEqual(taskUnits,[])
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
  await noNativeServices()
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
  await preserved(f,result); await noNativeServices()
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
  await noNativeServices()
})
test('session revocation aborts an active native container without holding identity locks across native execution',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true }), claim = await f.store.claim(f.job.id)
  const finished = f.executor.execute(claim); void finished.catch(() => {})
  await bounded(f.started.promise)
  await bounded(f.sessions.revoke(f.alice.token,f.alice.sessionId))
  await assert.rejects(() => bounded(finished),{ code: 'AUTHORITY_LOST' }); f.resume.resolve()
  assert.deepEqual(await metadata(f),{ state: 'cancelled',error: 'AUTH_REVOKED',versions: 1,receipts: 0,events: 0 })
  await noNativeServices()
})
test('lost SQL claim kills the old native process; only the reclaimed epoch can commit output',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true }), first = await f.store.claim(f.job.id)
  const finished = f.executor.execute(first); void finished.catch(() => {})
  await bounded(f.started.promise)
  await f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.id]))
  const next = await f.store.claim(f.job.id)
  assert.ok(next.epoch>first.epoch)
  await assert.rejects(() => bounded(finished),{ code: 'AUTHORITY_LOST' }); f.resume.resolve(); await noNativeServices()
  const result = await bounded(f.executor.execute(next))
  await preserved(f,result)
  assert.deepEqual(await metadata(f),{ state: 'succeeded',error: null,versions: 2,receipts: 1,events: 1 })
  await noNativeServices()
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
  await noNativeServices()
})

test('controller shutdown aborts native work, releases its edit lease and leaves a resumable SQL job',{ timeout: 30_000 },async t => {
  const f = await fixture(t,{ paused: true }), first = await f.store.claim(f.job.id), stop = new AbortController()
  const finished = f.executor.execute(first,{ signal: stop.signal }); void finished.catch(() => {})
  await bounded(f.started.promise); stop.abort()
  await assert.rejects(() => bounded(finished),{ code: 'ABORTED' }); f.resume.resolve()
  assert.deepEqual(await metadata(f),{ state: 'queued',error: 'WORKER_FAILED',versions: 1,receipts: 0,events: 0 })
  assert.equal((await f.leases.getLease(f.alice.token,f.file.fileId)).active,false)
  await noNativeServices()
  const next = await f.store.claim(f.job.id)
  assert.ok(next.epoch>first.epoch)
  await preserved(f,await f.executor.execute(next))
  assert.deepEqual(await metadata(f),{ state: 'succeeded',error: null,versions: 2,receipts: 1,events: 1 })
  await noNativeServices()
})

async function daemonEnvironment(f,bucket) {
  const manifest = JSON.parse(await readFile(process.env.DYOFFICE_TEST_HOST_MANIFEST ?? new URL('../../../../.dyoffice-native-build/host-manifest.json',import.meta.url),'utf8'))
  return { PATH: process.env.PATH,NODE_ENV: 'test',DYOFFICE_NATIVE_WORKER: 'experimental',DYOFFICE_WORKER_DATABASE_URL: f.urls.worker,DYOFFICE_BUSINESS_DATABASE_URL: f.urls.business,DYOFFICE_DEPLOYMENT_ID: f.deploymentId,DYOFFICE_REDIS_URL: process.env.DYOFFICE_TEST_REDIS_URL,DYOFFICE_NATIVE_BINARY: manifest.nativeBinary,DYOFFICE_NATIVE_SHA256: manifest.nativeSha256,DYOFFICE_FILE_API: 'experimental',DYOFFICE_OBJECT_STORE: 's3',DYOFFICE_S3_ENDPOINT: process.env.DYOFFICE_TEST_S3_ENDPOINT,DYOFFICE_S3_REGION: 'us-east-1',DYOFFICE_S3_BUCKET: bucket,DYOFFICE_S3_FORCE_PATH_STYLE: 'true',AWS_ACCESS_KEY_ID: process.env.DYOFFICE_TEST_S3_ACCESS_KEY,AWS_SECRET_ACCESS_KEY: process.env.DYOFFICE_TEST_S3_SECRET_KEY,DYOFFICE_WORKER_RUNTIME_DIRECTORY: join(f.directory,'worker-control') }
}
function daemon(env) {
  const child = spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../worker/src/main.ts',import.meta.url))],{ env,stdio: ['ignore','pipe','pipe'] })
  let stdout = '',stderr = '',readyTimer
  const exited = new Promise(resolve => child.once('exit',resolve))
  const ready = new Promise((resolve,reject) => {
    readyTimer=setTimeout(() => reject(new Error('Worker daemon did not become ready')),12000)
    child.once('error',reject); child.once('exit',() => { clearTimeout(readyTimer); reject(new Error('Worker daemon exited before ready')) })
    child.stdout.on('data',chunk => { stdout += chunk; if (stdout.includes('dyoffice-worker: ready\n')) { clearTimeout(readyTimer); resolve() } })
  }); void ready.catch(() => {})
  child.stderr.on('data',chunk => { stderr += chunk })
  return { child,ready,exited,get stdout() { return stdout },get stderr() { return stderr },async close() {
    clearTimeout(readyTimer)
    if (child.exitCode===null && child.signalCode===null) {
      child.kill('SIGTERM'); const timeout=setTimeout(() => child.kill('SIGKILL'),8000)
      try { await exited } finally { clearTimeout(timeout) }
    }
  } }
}
test('runnable daemon starts with restricted pools, consumes real queued API jobs and shuts down cleanly',{ timeout: 35_000 },async t => {
  const remote = await s3Fixture(t), f = await fixture(t,{ objectStore: remote.store }), service = daemon(await daemonEnvironment(f,remote.bucket))
  try {
    await service.ready
    const deadline=Date.now()+12000
    let stored
    do { stored=await f.jobs.getJob(f.alice.token,f.job.id); if (stored.state==='succeeded') break; assert.ok(Date.now()<deadline,'Worker daemon did not commit the queued job'); await new Promise(resolve => setTimeout(resolve,50)) } while(true)
    await preserved(f,{ revision: stored.resultRevision })
    assert.deepEqual(await metadata(f),{ state: 'succeeded',error: null,versions: 2,receipts: 1,events: 1 })
    const events=await createRevisionQueue({url:process.env.DYOFFICE_TEST_REDIS_URL,name:'dyoffice-revisions-'+f.deploymentId})
    try {
      let hints=[];const publishDeadline=Date.now()+5000
      while(!hints.length&&Date.now()<publishDeadline){hints=await events.queue.getWaiting();if(!hints.length)await new Promise(resolve=>setTimeout(resolve,50))}
      assert.equal(hints.length,1);assert.deepEqual(Object.keys(hints[0].data),['eventId'])
      const row=await f.transactions.withPrincipalTransaction({kind:'session',token:f.alice.token},async c=>(await c.query('SELECT revision_id FROM revision_outbox WHERE id=$1',[hints[0].data.eventId])).rows[0])
      assert.equal(row.revision_id,stored.resultRevision)
    }finally{await events.close()}
  } finally {
    await service.close()
    const events=await createRevisionQueue({url:process.env.DYOFFICE_TEST_REDIS_URL,name:'dyoffice-revisions-'+f.deploymentId})
    try{await events.queue.obliterate({force:true})}finally{await events.close()}
    const cleanup = await createJobQueue({ url: process.env.DYOFFICE_TEST_REDIS_URL,name: 'dyoffice-native-' + f.deploymentId })
    try { await cleanup.queue.obliterate({ force: true }) } finally { await cleanup.close() }
  }
  assert.equal(service.child.exitCode,0); assert.equal(service.stderr,'')
  await noNativeServices()
})
test('daemon refuses production, privileged credentials, unknown deployment and stale schema before claiming jobs',{ timeout: 35_000 },async t => {
  const remote = await s3Fixture(t), f = await fixture(t,{ objectStore: remote.store }), env = await daemonEnvironment(f,remote.bucket)
  const original = (await f.ownerPool.query('SELECT sha256 FROM identity_migrations WHERE version=5')).rows[0].sha256
  const cases = [{ ...env,NODE_ENV: 'production' },{ ...env,DYOFFICE_DATABASE_URL: f.urls.owner },{ ...env,DYOFFICE_AUTH_DATABASE_URL: f.urls.auth },{ ...env,DYOFFICE_DEPLOYMENT_ID: randomUUID() }]
  cases.push({ ...env,stale: true })
  try {
    for (const environment of cases) {
      if ('stale' in environment) await f.ownerPool.query("UPDATE identity_migrations SET sha256=$1 WHERE version=5",['0'.repeat(64)])
      const { stale,...settings }=environment
      const service=daemon(settings)
      try { await bounded(service.exited) } finally { await service.close() }
      assert.equal(service.child.exitCode,1); assert.equal(service.stdout,''); assert.equal(service.stderr,'dyoffice-worker: startup failed\n')
    }
  } finally { await f.ownerPool.query('UPDATE identity_migrations SET sha256=$1 WHERE version=5',[original]) }
  assert.deepEqual(await metadata(f),{ state: 'queued',error: null,versions: 1,receipts: 0,events: 0 })
  await noNativeServices()
})
