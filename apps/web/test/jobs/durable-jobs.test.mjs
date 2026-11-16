import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { jobFixture as fixture } from '../helpers/jobs.mjs'
const enqueue = (f,key = randomUUID()) => f.jobs.enqueueJob(f.alice.token,'docx.roundtrip',f.input,key)
const expire = (f,id) => f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]))

test('owned job and durable dispatch intent commit atomically and an idempotent retry retains one job',async t => {
  const f = await fixture(t), key = randomUUID(), job = await enqueue(f,key)
  assert.equal(job.state,'queued')
  assert.equal(job.artifactId,f.input.artifactId)
  assert.equal((await enqueue(f,key)).id,job.id)
  assert.equal(JSON.stringify(job).includes('object_key'),false)
  const count = await f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query('SELECT (SELECT count(*) FROM native_jobs)::int AS jobs,(SELECT count(*) FROM job_outbox)::int AS intents'))
  assert.deepEqual(count.rows[0],{ jobs: 1,intents: 1 })
  await f.ownerPool.query("CREATE FUNCTION reject_job_intent() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'controlled intent failure'; END$$")
  await f.ownerPool.query('CREATE TRIGGER reject_intent BEFORE INSERT ON job_outbox FOR EACH ROW EXECUTE FUNCTION reject_job_intent()')
  await assert.rejects(() => enqueue(f))
  assert.equal((await f.jobs.listJobs(f.alice.token)).jobs.length,1)
})
test('B/Admin cannot enqueue, read or cancel A jobs and caller-supplied identity is rejected',async t => {
  const f = await fixture(t), job = await enqueue(f)
  for (const token of [f.bob.token,f.adminSigned.token]) {
    await assert.rejects(() => f.jobs.enqueueJob(token,'docx.roundtrip',f.input,randomUUID()),{ statusCode: 404 })
    await assert.rejects(() => f.jobs.getJob(token,job.id),{ statusCode: 404 })
    await assert.rejects(() => f.jobs.cancelJob(token,job.id),{ statusCode: 404 })
  }
  await assert.rejects(() => f.jobs.enqueueJob(f.alice.token,'docx.roundtrip',{ ...f.input,ownerId: f.bob.user.id },randomUUID()),{ statusCode: 400 })
  await assert.rejects(() => f.jobs.enqueueJob(f.alice.token,'shell.exec',f.input,randomUUID()),{ statusCode: 400 })
})
test('only one worker may hold a job and an expired claim is fenced by a new epoch',async t => {
  const f = await fixture(t), job = await enqueue(f)
  const claims = await Promise.all([f.worker.claim(job.id),f.worker.claim(job.id)])
  assert.equal(claims.filter(Boolean).length,1)
  const first = claims.find(Boolean)
  assert.equal(first.artifactId,f.input.artifactId)
  assert.equal(first.sha256.length,64)
  assert.equal((await f.worker.renew(first)).epoch,first.epoch)
  await expire(f,job.id)
  assert.equal(await f.worker.renew(first),null)
  const next = await f.worker.claim(job.id)
  assert.ok(next.epoch > first.epoch)
  assert.equal(await f.worker.fail(first,'WORKER_FAILED',false),false)
  assert.equal((await f.jobs.getJob(f.alice.token,job.id)).state,'running')
})
test('cancel and session revocation fence current claims and preserve the original artifact',async t => {
  const f = await fixture(t), job = await enqueue(f), claim = await f.worker.claim(job.id)
  assert.equal((await f.jobs.cancelJob(f.alice.token,job.id)).state,'cancelled')
  assert.equal(await f.worker.renew(claim),null)
  assert.equal(await f.worker.claim(job.id),null)
  const next = await enqueue(f), active = await f.worker.claim(next.id)
  await f.sessions.revoke(f.alice.token,f.alice.sessionId)
  assert.equal(await f.worker.renew(active),null)
  const row = await f.ownerPool.query('SELECT state,error_code FROM native_jobs WHERE id=$1',[next.id])
  assert.deepEqual(row.rows[0],{ state: 'cancelled',error_code: 'AUTH_REVOKED' })
  assert.equal((await f.files.openFile(f.bob.token, f.fileId).catch(error => error)).statusCode,404)
})
test('deadline and retry budgets are PostgreSQL authority and failed attempts cannot resurrect a cancelled job',async t => {
  const f = await fixture(t), job = await enqueue(f)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = await f.worker.claim(job.id)
    assert.equal(claim.attempt,attempt)
    assert.equal(await f.worker.fail(claim,'WORKER_FAILED',true),true)
  }
  assert.equal((await f.jobs.getJob(f.alice.token,job.id)).state,'failed')
  assert.equal(await f.worker.claim(job.id),null)
  const timed = await enqueue(f)
  await f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query("UPDATE native_jobs SET created_at=clock_timestamp()-interval '1 minute',deadline_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[timed.id]))
  assert.equal(await f.worker.claim(timed.id),null)
  assert.equal((await f.jobs.getJob(f.alice.token,timed.id)).errorCode,'TIMEOUT')
})

test('worker control role has no table access and API roles cannot claim jobs or call private helpers',async t => {
  const f = await fixture(t), job = await enqueue(f)
  const { assertRuntimePool } = await import('../../server/src/db/roles.ts')
  await assertRuntimePool(f.workerPool,'worker')
  for (const relation of ['users','sessions','files','file_revisions','native_jobs','job_outbox']) await assert.rejects(() => f.workerPool.query('SELECT * FROM ' + relation),{ code: '42501' })
  assert.equal((await f.businessPool.query('SELECT * FROM native_jobs')).rowCount,0)
  for (const pool of [f.authPool,f.businessPool]) await assert.rejects(() => pool.query('SELECT claim_native_job($1,$2,$3,30000)',[f.deploymentId,job.id,'a'.repeat(64)]),{ code: '42501' })
  await assert.rejects(() => f.workerPool.query('SELECT lock_native_job($1,$2)',[f.deploymentId,job.id]),{ code: '42501' })
  await f.ownerPool.query('GRANT SELECT ON files TO ' + f.names.worker)
  await assert.rejects(() => assertRuntimePool(f.workerPool,'worker'),/outside its boundary/)
  await f.ownerPool.query('REVOKE SELECT ON files FROM ' + f.names.worker)
  await f.ownerPool.query('GRANT EXECUTE ON FUNCTION claim_native_job(uuid,uuid,text,integer) TO ' + f.names.worker + ' WITH GRANT OPTION')
  await assert.rejects(() => assertRuntimePool(f.workerPool,'worker'),/Unsafe/)
})
for (const boundary of ['session','job']) test(`a ${boundary} deadline expiring behind a real file lock cannot authorize a late worker claim`,async t => {
  const f = await fixture(t), job = await enqueue(f), held = await f.ownerPool.connect()
  let pending
  await f.worker.takeDelivery() // warm role admission before starting the deadline
  try {
    await held.query('BEGIN')
    await held.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
    await held.query('SELECT id FROM files WHERE id=$1 FOR UPDATE',[f.fileId])
    if (boundary === 'session') await f.ownerPool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",[f.alice.sessionId])
    else await f.ownerPool.query("UPDATE native_jobs SET deadline_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",[job.id])
    pending = f.worker.claim(job.id)
    const deadline = Date.now()+4000
    while (!(await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[f.workerPool.options.application_name])).rowCount) {
      assert.ok(Date.now()<deadline,'Worker never waited on the actual file row lock')
      await new Promise(resolve => setTimeout(resolve,10))
    }
    const sql = boundary === 'session' ? 'SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE id=$1' : 'SELECT deadline_at<=clock_timestamp() AS expired FROM native_jobs WHERE id=$1'
    const id = boundary === 'session' ? f.alice.sessionId : job.id
    while (!(await f.ownerPool.query(sql,[id])).rows[0].expired) await new Promise(resolve => setTimeout(resolve,10))
    await held.query('COMMIT')
    assert.ok((await pending) === null,'Expired authority must not produce a worker claim')
    const state = (await f.ownerPool.query('SELECT state,error_code FROM native_jobs WHERE id=$1',[job.id])).rows[0]
    assert.equal(state.error_code,boundary === 'session' ? 'AUTH_REVOKED' : 'TIMEOUT')
  } finally { await held.query('ROLLBACK'); held.release(); await pending?.catch(() => {}) }
})
test('a delivery acknowledgement cannot revive its expired lease after waiting on an outbox lock',async t => {
  const f = await fixture(t,{ workerPolicy: { deliveryLeaseMs: 250 } }), job = await enqueue(f), delivery = await f.worker.takeDelivery(), held = await f.ownerPool.connect()
  let pending
  try {
    await held.query('BEGIN'); await held.query('SELECT job_id FROM job_outbox WHERE job_id=$1 FOR UPDATE',[job.id])
    pending = f.worker.ackDelivery(delivery)
    const deadline = Date.now()+4000
    while (!(await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[f.workerPool.options.application_name])).rowCount) {
      assert.ok(Date.now()<deadline,'Ack never waited on real outbox row lock'); await new Promise(resolve => setTimeout(resolve,10))
    }
    while (!(await f.ownerPool.query('SELECT lease_until<=clock_timestamp() AS expired FROM job_outbox WHERE job_id=$1',[job.id])).rows[0].expired) await new Promise(resolve => setTimeout(resolve,10))
    await held.query('COMMIT')
    assert.equal(await pending,false)
  } finally { await held.query('ROLLBACK'); held.release(); await pending?.catch(() => {}) }
})
test('worker database lock waits have a bounded timeout and leave the connection reusable', { timeout: 15_000 },async t => {
  const f = await fixture(t), job = await enqueue(f)
  await f.worker.takeDelivery()
  const held = await f.ownerPool.connect()
  let releaseTimer
  try {
    await held.query('BEGIN'); await held.query('SELECT id FROM native_jobs WHERE id=$1 FOR UPDATE',[job.id])
    releaseTimer = setTimeout(() => { void held.query('COMMIT') },5800)
    await assert.rejects(() => f.worker.claim(job.id),{ code: '55P03' })
    assert.equal((await f.workerPool.query('SELECT 1 AS ok')).rows[0].ok,1)
  } finally { clearTimeout(releaseTimer); await held.query('ROLLBACK'); held.release() }
})
test('concurrent enqueue enforces one owner quota and retrying an accepted key remains idempotent at capacity',async t => {
  const f = await fixture(t,{ jobPolicy: { maxActiveJobs: 1 } }), keys = [randomUUID(),randomUUID()]
  const results = await Promise.allSettled(keys.map(key => enqueue(f,key)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1)
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode,429)
  const winner = results.findIndex(result => result.status === 'fulfilled')
  assert.equal((await enqueue(f,keys[winner])).id,results[winner].value.id)
  await f.jobs.cancelJob(f.alice.token,results[winner].value.id)
  assert.equal((await enqueue(f)).state,'queued')
})
test('runtime provisioning CLI installs the optional restricted worker role idempotently',async t => {
  const f = await fixture(t), { execFile } = await import('node:child_process'), { promisify } = await import('node:util'), { fileURLToPath } = await import('node:url')
  const { assertRuntimePool } = await import('../../server/src/db/roles.ts')
  const { stdout,stderr } = await promisify(execFile)(process.execPath,['--experimental-strip-types','tools/dyoffice/provision-runtime.ts'],{ cwd: fileURLToPath(new URL('../../../../',import.meta.url)),env: { ...process.env,DYOFFICE_DATABASE_URL: f.urls.owner,DYOFFICE_AUTH_ROLE: f.names.auth,DYOFFICE_BUSINESS_ROLE: f.names.business,DYOFFICE_WORKER_ROLE: f.names.worker },timeout: 5000 })
  assert.match(stdout,/Runtime database grants installed/)
  for (const url of Object.values(f.urls)) assert.equal((stdout+stderr).includes(new URL(url).password),false)
  await assertRuntimePool(f.workerPool,'worker')
  await assertRuntimePool(f.businessPool,'business')
})
test('jobs inherit the authenticated transaction idle policy rather than granting a longer background session',async t => {
  const f = await fixture(t), { createPrincipalTransactions } = await import('../../server/src/db/context.ts'), { createJobService } = await import('../../server/src/modules/jobs/service.ts')
  const transactions = createPrincipalTransactions({ pool: f.businessPool,deploymentId: f.deploymentId,idleMs: 10_000 })
  const jobs = createJobService({ transactions,enabledTypes: ['docx.roundtrip'] })
  const job = await jobs.enqueueJob(f.alice.token,'docx.roundtrip',f.input,randomUUID())
  await f.ownerPool.query("UPDATE sessions SET last_seen_at=clock_timestamp()-interval '11 seconds' WHERE id=$1",[f.alice.sessionId])
  assert.ok((await f.worker.claim(job.id)) === null,'A job must not widen the source session idle window')
  assert.equal((await f.ownerPool.query('SELECT error_code FROM native_jobs WHERE id=$1',[job.id])).rows[0].error_code,'AUTH_REVOKED')
})
