import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID,randomBytes } from 'node:crypto'
import { jobFixture } from '../helpers/jobs.mjs'
import { docxBytes,importFile } from '../helpers/files.mjs'
import { tokenHash } from '../../server/src/modules/auth/sessions.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
const credential = c => ({ kind: 'job',jobId: c.jobId,epoch: c.epoch,token: c.token })
async function setup(t,options) {
  const f = await jobFixture(t,options)
  return { ...f,leases: createLeaseService({ transactions: f.transactions }),revisions: createRevisionService({ transactions: f.transactions,objects: f.objects,files: f.files }) }
}
async function claimed(f) {
  const job = await f.jobs.enqueueJob(f.alice.token,'docx.roundtrip',f.input,randomUUID())
  const claim = await f.worker.claim(job.id)
  assert.ok(claim); return { job,claim,auth: credential(claim) }
}
async function output(f,auth) {
  const lease = await f.leases.acquireLease(auth,f.fileId,{ editorId: auth.jobId })
  const bytes = await docxBytes()
  const upload = await f.revisions.stageUpload(auth,f.fileId,{ size: bytes.length,baseRevision: f.input.artifactId,leaseEpoch: lease.leaseEpoch,editorId: auth.jobId })
  await f.files.receiveUpload(auth,upload.uploadId,bytes)
  return { fileId: f.fileId,uploadId: upload.uploadId,baseRevision: f.input.artifactId,leaseEpoch: lease.leaseEpoch,idempotencyKey: 'job_' + auth.jobId }
}
async function snapshot(f) {
  return f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },async c => (await c.query('SELECT (SELECT current_revision FROM files WHERE id=$1) AS head,(SELECT count(*)::int FROM file_revisions) AS versions,(SELECT count(*)::int FROM revision_commits) AS receipts,(SELECT count(*)::int FROM revision_outbox) AS events,(SELECT stored_bytes::text FROM storage_accounts) AS stored,(SELECT reserved_bytes::text FROM storage_accounts) AS reserved',[f.fileId])).rows[0])
}
test('job credential derives identity from the locked SQL claim and rejects spoofed or malformed capabilities',async t => {
  const f = await setup(t), { auth } = await claimed(f)
  const principal = await f.transactions.withPrincipalTransaction(auth,async (_c,p) => p)
  assert.equal(principal.userId,f.alice.user.id); assert.equal(principal.sessionId,f.alice.sessionId)
  assert.deepEqual(principal.job,{ id: auth.jobId,epoch: auth.epoch,fileId: f.fileId,baseRevision: f.input.artifactId })
  assert.equal(principal.scopes.includes('preferences:write'),false)
  for (const pool of [f.authPool,f.workerPool]) {
    await assert.rejects(() => pool.query('SELECT lock_job_principal($1,$2,$3,$4,false)',[f.deploymentId,auth.jobId,auth.epoch,'0'.repeat(64)]),{ code: '42501' })
    await assert.rejects(() => pool.query('SELECT complete_native_job($1,$2,$3,$4,$5)',[f.deploymentId,auth.jobId,auth.epoch,'0'.repeat(64),f.input.artifactId]),{ code: '42501' })
  }
  await assert.rejects(() => f.transactions.withPrincipalTransaction(auth,c => c.query('SELECT complete_native_job($1,$2,$3,$4,$5)',[f.deploymentId,auth.jobId,auth.epoch,tokenHash(auth.token),f.input.artifactId])),{ statusCode: 401 })
  for (const bad of [{ ...auth,token: randomBytes(32).toString('base64url') },{ ...auth,epoch: auth.epoch+1 },{ ...auth,ownerId: f.bob.user.id },{ ...auth,jobId: randomUUID() }]) await assert.rejects(() => f.transactions.withPrincipalTransaction(bad,async () => {}),{ statusCode: 401 })
})
test('job file authority cannot reach another file, arbitrary editor, import, rename, history or another job draft',async t => {
  const f = await setup(t), other = await importFile(f,f.alice.token,await docxBytes(),'other.docx'), { auth } = await claimed(f)
  assert.equal((await f.files.readFile(auth,f.fileId,f.input.artifactId)).length,(await docxBytes()).length)
  await assert.rejects(() => f.files.readFile(auth,other.file.fileId,other.file.revision),{ statusCode: 404 })
  for (const action of [() => f.files.stageUpload(auth,{ name: 'escape.docx',size: 100 }),() => f.files.renameFile(auth,f.fileId,'renamed.docx'),() => f.files.trashFile(auth,f.fileId),() => f.files.restoreFile(auth,f.fileId),() => f.files.listFiles(auth),() => f.files.usage(auth),() => f.revisions.listRevisions(auth,f.fileId),() => f.leases.acquireLease(auth,f.fileId,{ editorId: randomUUID() })]) await assert.rejects(action,{ statusCode: 404 })
  const draft = await output(f,auth), second = await claimed(f)
  await assert.rejects(() => f.files.preflightUpload(second.auth,draft.uploadId),{ statusCode: 404 })
  await assert.rejects(() => f.files.preflightUpload(f.alice.token,draft.uploadId),{ statusCode: 404 })
  await assert.rejects(() => f.leases.takeoverLease(second.auth,f.fileId,{ editorId: second.auth.jobId,expectedEpoch: draft.leaseEpoch }),{ statusCode: 404 })
})
test('expired, cancelled and revoked job authority cannot enter or finish a business transaction',async t => {
  const f = await setup(t), first = await claimed(f)
  await f.jobs.cancelJob(f.alice.token,first.job.id)
  await assert.rejects(() => f.transactions.withPrincipalTransaction(first.auth,async () => {}),{ statusCode: 401 })
  const next = await claimed(f)
  await assert.rejects(() => f.transactions.withPrincipalTransaction(next.auth,async c => {
    await c.query("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[next.job.id])
  }),{ statusCode: 401 })
  assert.equal((await f.jobs.getJob(f.alice.token,next.job.id)).state,'running')
  await f.sessions.revoke(f.alice.token,f.alice.sessionId)
  await assert.rejects(() => f.transactions.withPrincipalTransaction(next.auth,async () => {}),{ statusCode: 401 })
})
test('output revision and job success commit together; completion failure rolls back head, receipt, event and quota',async t => {
  const f = await setup(t), { auth,job } = await claimed(f), save = await output(f,auth), before = await snapshot(f)
  await f.ownerPool.query("CREATE FUNCTION reject_job_success() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='succeeded' THEN RAISE EXCEPTION 'controlled completion failure'; END IF; RETURN NEW; END$$")
  await f.ownerPool.query('CREATE TRIGGER reject_success BEFORE UPDATE ON native_jobs FOR EACH ROW EXECUTE FUNCTION reject_job_success()')
  await assert.rejects(() => f.revisions.commitRevision(auth,save),/controlled completion failure/)
  assert.deepEqual(await snapshot(f),before); assert.equal((await f.jobs.getJob(f.alice.token,job.id)).state,'running')
  assert.equal((await f.leases.getLease(f.alice.token,f.fileId)).active,true)
  await f.ownerPool.query('DROP TRIGGER reject_success ON native_jobs')
  const result = await f.revisions.commitRevision(auth,save), after = await snapshot(f)
  assert.equal(after.head,result.revision); assert.equal(after.versions,before.versions+1); assert.equal(after.receipts,1); assert.equal(after.events,1)
  assert.equal((await f.jobs.getJob(f.alice.token,job.id)).resultRevision,result.revision)
  assert.equal((await f.jobs.getJob(f.alice.token,job.id)).state,'succeeded')
  assert.equal(await f.worker.claim(job.id),null)
  assert.equal((await f.leases.getLease(f.alice.token,f.fileId)).active,false)
  await assert.rejects(() => f.revisions.commitRevision(auth,save),{ statusCode: 401 })
  await assert.rejects(() => f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query('SELECT lock_job_principal($1,$2,$3,$4,true)',[f.deploymentId,auth.jobId,auth.epoch,tokenHash(auth.token)])),{ statusCode: 401 })
  assert.deepEqual(await snapshot(f),after)
})
test('an active editor is not displaced by native output, and cancellation fences already staged output',async t => {
  const f = await setup(t), { auth,job } = await claimed(f), editorId = randomUUID()
  const browser = await f.leases.acquireLease(f.alice.token,f.fileId,{ editorId })
  await assert.rejects(() => f.leases.acquireLease(auth,f.fileId,{ editorId: auth.jobId }),{ statusCode: 409 })
  await f.leases.releaseLease(f.alice.token,f.fileId,{ editorId,leaseEpoch: browser.leaseEpoch })
  const save = await output(f,auth), before = await snapshot(f)
  await f.jobs.cancelJob(f.alice.token,job.id)
  assert.equal((await f.leases.getLease(f.alice.token,f.fileId)).active,false)
  await assert.rejects(() => f.revisions.commitRevision(auth,save),{ statusCode: 401 })
  assert.deepEqual(await snapshot(f),before)
})
test('caller mutation cannot switch the authority used for the final transaction recheck',async t => {
  const f = await setup(t), first = await claimed(f), second = await claimed(f), mutable = { ...first.auth }
  await assert.rejects(() => f.transactions.withPrincipalTransaction(mutable,async c => {
    await c.query("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[first.job.id])
    Object.assign(mutable,second.auth)
  }),{ statusCode: 401 })
})
test('reclaimed worker epoch cannot reuse an earlier attempt draft or produce two versions',async t => {
  const f = await setup(t), first = await claimed(f), oldSave = await output(f,first.auth)
  await f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query("UPDATE native_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[first.job.id]))
  const next = await f.worker.claim(first.job.id), auth = credential(next)
  assert.ok(next.epoch>first.claim.epoch)
  await assert.rejects(() => f.revisions.commitRevision(first.auth,oldSave),{ statusCode: 401 })
  await assert.rejects(() => f.files.preflightUpload(auth,oldSave.uploadId),{ statusCode: 404 })
  const fresh = await output(f,auth), before = await snapshot(f)
  assert.ok(fresh.leaseEpoch>oldSave.leaseEpoch)
  const result = await f.revisions.commitRevision(auth,fresh)
  assert.equal((await snapshot(f)).versions,before.versions+1)
  assert.equal((await f.jobs.getJob(f.alice.token,first.job.id)).resultRevision,result.revision)
  assert.equal(await f.worker.claim(first.job.id),null)
})
test('a browser save on a newer lease fences previously staged native output',async t => {
  const f = await setup(t), { auth,job } = await claimed(f), oldSave = await output(f,auth), editorId = randomUUID()
  const lease = await f.leases.takeoverLease(f.alice.token,f.fileId,{ editorId,expectedEpoch: oldSave.leaseEpoch })
  const bytes = await docxBytes(), upload = await f.revisions.stageUpload(f.alice.token,f.fileId,{ size: bytes.length,baseRevision: f.input.artifactId,leaseEpoch: lease.leaseEpoch,editorId })
  await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
  await f.revisions.commitRevision(f.alice.token,{ fileId: f.fileId,uploadId: upload.uploadId,baseRevision: f.input.artifactId,leaseEpoch: lease.leaseEpoch,idempotencyKey: randomUUID() })
  const before = await snapshot(f)
  await assert.rejects(() => f.revisions.commitRevision(auth,oldSave),{ statusCode: 404 })
  assert.deepEqual(await snapshot(f),before); assert.equal((await f.jobs.getJob(f.alice.token,job.id)).state,'running')
  await f.leases.releaseLease(f.alice.token,f.fileId,{ editorId,leaseEpoch: lease.leaseEpoch })
  const native = await f.leases.acquireLease(auth,f.fileId,{ editorId: auth.jobId })
  await assert.rejects(() => f.revisions.stageUpload(auth,f.fileId,{ size: bytes.length,baseRevision: f.input.artifactId,leaseEpoch: native.leaseEpoch,editorId: auth.jobId }),{ statusCode: 409 })
})
test('a job deadline elapsed during real object I/O rolls back every output metadata change',async t => {
  let delay = false, delayedVerification = false
  const f = await setup(t,{ wrapObjects: base => ({ ...base,async verifyObject(ref) { if (delay) { delayedVerification = true; await new Promise(resolve => setTimeout(resolve,750)) }; return base.verifyObject(ref) } }) })
  const { auth,job } = await claimed(f), save = await output(f,auth), before = await snapshot(f)
  await f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },c => c.query("UPDATE native_jobs SET deadline_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[job.id]))
  delay = true
  await assert.rejects(() => f.revisions.commitRevision(auth,save),{ statusCode: 401 })
  delay = false
  assert.equal(delayedVerification,true,'deadline must cross the verification-only object I/O path')
  assert.deepEqual(await snapshot(f),before)
  assert.equal((await f.jobs.getJob(f.alice.token,job.id)).state,'running')
})

test('controller death after real SQL COMMIT cannot duplicate output on a repeated worker claim',{ timeout: 20_000 },async t => {
  const f = await setup(t), { auth,job } = await claimed(f), save = await output(f,auth), before = await snapshot(f)
  const child = spawn(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../fixtures/commit-and-crash.mjs',import.meta.url))],{ stdio: ['pipe','pipe','pipe'] })
  t.after(() => { if (child.exitCode===null) child.kill('SIGKILL') })
  let stdout = '',stderr = ''
  child.stdout.on('data',chunk => { stdout += chunk }); child.stderr.on('data',chunk => { stderr += chunk })
  const exited = new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve) })
  child.stdin.end(JSON.stringify({ url: f.urls.business,deploymentId: f.deploymentId,directory: f.directory,auth,save }))
  assert.equal(await exited,86); assert.equal(stdout,''); assert.equal(stderr,'')
  const after = await snapshot(f), stored = await f.jobs.getJob(f.alice.token,job.id)
  assert.equal(stored.state,'succeeded'); assert.equal(stored.resultRevision,after.head)
  assert.equal(after.versions,before.versions+1); assert.equal(after.receipts,before.receipts+1); assert.equal(after.events,before.events+1)
  assert.equal(await f.worker.claim(job.id),null)
  await assert.rejects(() => f.revisions.commitRevision(auth,save),{ statusCode: 401 })
  assert.deepEqual(await snapshot(f),after)
})
test('a public job UUID cannot make a live browser lease interchangeable with a job lease',async t => {
  const f = await setup(t), { auth } = await claimed(f)
  const browser = await f.leases.acquireLease(f.alice.token,f.fileId,{ editorId: auth.jobId })
  await assert.rejects(() => f.leases.acquireLease(auth,f.fileId,{ editorId: auth.jobId }),{ statusCode: 409 })
  await f.leases.releaseLease(f.alice.token,f.fileId,{ editorId: auth.jobId,leaseEpoch: browser.leaseEpoch })
  const native = await f.leases.acquireLease(auth,f.fileId,{ editorId: auth.jobId })
  assert.equal((await f.leases.getLease(f.alice.token,f.fileId)).heldByCurrentSession,false)
  const bounded = await f.transactions.withPrincipalTransaction({ kind: 'session',token: f.alice.token },async c => (await c.query('SELECT l.job_id,l.job_epoch,l.expires_at<=j.lease_until AS bounded FROM edit_leases l JOIN native_jobs j ON j.id=l.job_id WHERE l.file_id=$1',[f.fileId])).rows[0])
  assert.deepEqual(bounded,{ job_id: auth.jobId,job_epoch: String(auth.epoch),bounded: true })
  await assert.rejects(() => f.leases.renewLease(f.alice.token,f.fileId,{ editorId: auth.jobId,leaseEpoch: native.leaseEpoch }),{ statusCode: 404 })
  await assert.rejects(() => f.leases.releaseLease(f.alice.token,f.fileId,{ editorId: auth.jobId,leaseEpoch: native.leaseEpoch }),{ statusCode: 404 })
})
