import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { s3Fixture } from '../helpers/s3.mjs'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'

test('disposable PG/RustFS save verification benchmark', { skip: process.env.DYOFFICE_RUN_SAVE_BENCHMARK !== 'synthetic-local-only', timeout: 120_000 }, async t => {
  const { store } = await s3Fixture(t)
  let mode = 'verify', observation, f
  const objects = { ...store, async verifyObject(reference) {
    const start = performance.now(), before = process.memoryUsage()
    // Start a real same-owner account-lock waiter after commit has taken its locks.
    const waiting = f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, async connection => {
      await connection.query('SELECT 1 FROM storage_accounts WHERE deployment_id=$1 AND owner_id=$2 FOR UPDATE', [f.deploymentId, f.alice.user.id])
      return performance.now() - start
    })
    let bytes
    if (mode === 'collect') bytes = await store.readVerified(reference)
    else await store.verifyObject(reference)
    const after = process.memoryUsage()
    observation = { verifyMs: performance.now() - start, before, after, waiting }
    if (bytes) assert.equal(bytes.length, reference.size)
  } }
  // Setup uses ordinary store, so no benchmark waiter exists during setup.
  f = await fileFixture(t, { objectStore: store })
  const original = await docxBytes(), opened = await importFile(f, f.alice.token, original)
  const fileId = opened.file.fileId, editorId = randomUUID()
  const leases = createLeaseService({ transactions: f.transactions })
  const lease = await leases.acquireLease(f.alice.token, fileId, { editorId })
  const revisions = createRevisionService({ transactions: f.transactions, files: f.files, objects })
  const zip = await JSZip.loadAsync(original)
  zip.file('benchmark-padding.bin', randomBytes(8 * 1024 * 1024))
  const payload = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  let baseRevision = opened.file.revision
  const samples = []
  for (let round = 0; round < 4; round++) for (mode of (round % 2 ? ['verify', 'collect'] : ['collect', 'verify'])) {
    const upload = await revisions.stageUpload(f.alice.token, fileId, { size: payload.length, baseRevision, leaseEpoch: lease.leaseEpoch, editorId })
    await f.files.receiveUpload(f.alice.token, upload.uploadId, payload)
    observation = undefined
    const start = performance.now()
    const result = await revisions.commitRevision(f.alice.token, { fileId, uploadId: upload.uploadId, baseRevision, leaseEpoch: lease.leaseEpoch, idempotencyKey: randomUUID() })
    const commitMs = performance.now() - start
    const sameOwnerLockWaitMs = await observation.waiting
    const { waiting, ...measured } = observation
    samples.push({ round, warmup: round === 0, mode, commitMs, sameOwnerLockWaitMs, ...measured })
    baseRevision = result.revision
  }
  const report = { timestamp: new Date().toISOString(), node: process.version, objectBytes: payload.length, method: 'Single disposable PostgreSQL database and RustFS bucket, real commit and hash verification. Sequential same-file saves alternating old collect/new verify, one warmup round then three samples each; same-owner lock waiter started at object I/O. Instrumented microbenchmark, not production p95/capacity. before/after memory is not peak; payload fixture and S3/DB resource use remain outside interpretation.', samples }
  assert.ok(process.env.DYOFFICE_SAVE_REPORT)
  await writeFile(process.env.DYOFFICE_SAVE_REPORT, JSON.stringify(report, null, 2))
})
