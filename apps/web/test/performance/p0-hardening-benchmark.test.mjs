import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { s3Fixture } from '../helpers/s3.mjs'
import { createLeaseService } from '../../server/src/modules/leases/service.ts'
import { createRevisionService } from '../../server/src/modules/revisions/service.ts'

import { restrictedIdentityFixture } from '../helpers/restricted-identity.mjs'
import { password } from '../helpers/identity.mjs'
import { createSessionService } from '../../server/src/modules/auth/sessions.ts'

const summary = values => {
  const sorted = [...values].sort((a,b) => a-b)
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length/2)], p95Ms: sorted[Math.ceil(sorted.length*0.95)-1] }
}

test('P0 identity authority timings retain every request and transaction query', { skip: process.env.DYOFFICE_RUN_P0_AUTH_BENCHMARK !== 'synthetic-local-only',timeout: 60_000 }, async t => {
  const f = await restrictedIdentityFixture(t)
  let counting=false,queries=0
  const db = { ...f.db,pool: new Proxy(f.db.pool,{ get(target,property) {
    if (property !== 'query') return Reflect.get(target,property)
    return (...args) => { if(counting)queries++;return target.query(...args) }
  } }),transaction: operation => f.db.transaction(connection => operation(new Proxy(connection,{ get(target,property) {
    if (property !== 'query') return Reflect.get(target,property)
    return (...args) => { if(counting)queries++;return target.query(...args) }
  } }))) }
  const sessions=createSessionService({ db,accounts: f.accounts,deploymentId: f.deploymentId })
  const signed=await sessions.login('owner',password),samples=[],counts=[]
  for(let i=0;i<120;i++) {
    queries=0;counting=true;const start=performance.now()
    assert.equal((await sessions.authenticate(signed.token)).userId,f.user.id)
    const elapsed=performance.now()-start;counting=false
    if(i>=20){samples.push(elapsed);counts.push(queries)}
  }
  t.diagnostic('P0_AUTH_MEASUREMENTS '+JSON.stringify({ label: process.env.DYOFFICE_P0_LABEL ?? 'unspecified',method: 'One disposable PostgreSQL identity fixture, 20 warmup then 100 sequential authenticate calls, unchanged pools; counted queries exclude BEGIN/SET/COMMIT, fixed on both sides. Local observation, not production p95.',...summary(samples),queryCounts: [...new Set(counts)],raw: samples }))
})

test('P0 authenticated request, immutable publication and real PG/S3 commit timings', { skip: process.env.DYOFFICE_RUN_P0_BENCHMARK !== 'synthetic-local-only', timeout: 120_000 }, async t => {
  const { store } = await s3Fixture(t)
  const f = await fileFixture(t, { objectStore: store })
  const original = await docxBytes(), initial = (await importFile(f,f.alice.token,original)).file
  const editorId = randomUUID(), leases = createLeaseService({ transactions: f.transactions })
  const lease = await leases.acquireLease(f.alice.token,initial.fileId,{ editorId })
  let sql = 0, counting = false, verificationMs = 0
  const transactions = { withPrincipalTransaction: (credential,operation) => f.transactions.withPrincipalTransaction(credential,(connection,principal) => operation(new Proxy(connection,{ get(target,property) {
    if (property !== 'query') return Reflect.get(target,property)
    return (...args) => { if (counting) sql++; return target.query(...args) }
  } }),principal)) }
  const objects = { ...store,async verifyObject(ref) {
    const start = performance.now(); await store.verifyObject(ref); verificationMs += performance.now()-start
  } }
  const revisions = createRevisionService({ transactions,objects,files: f.files })
  const zip = await JSZip.loadAsync(original)
  zip.file('benchmark-padding.bin',randomBytes(8*1024*1024))
  const bytes = await zip.generateAsync({ type: 'nodebuffer',compression: 'STORE' })
  const auth = [], publication = [], commits = [], retries = [], queries = [], verifications = []
  let baseRevision = initial.revision
  for (let round=0;round<9;round++) {
    for (let i=0;i<5;i++) {
      const start = performance.now(); await f.sessions.authenticate(f.alice.token)
      if (round) auth.push(performance.now()-start)
    }
    let start = performance.now()
    const ref = await store.putImmutable(`${f.deploymentId}/${f.alice.user.id}/objects/${randomUUID()}`,bytes)
    if (round) publication.push(performance.now()-start)
    await store.removeUnreferenced(ref.key)
    const upload = await revisions.stageUpload(f.alice.token,initial.fileId,{ size: bytes.length,baseRevision,leaseEpoch: lease.leaseEpoch,editorId })
    await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
    const input = { fileId: initial.fileId,uploadId: upload.uploadId,baseRevision,leaseEpoch: lease.leaseEpoch,idempotencyKey: randomUUID() }
    sql=0;verificationMs=0;counting=true;start=performance.now()
    const saved = await revisions.commitRevision(f.alice.token,input)
    const commitMs = performance.now()-start;counting=false
    if (round) { commits.push(commitMs);queries.push(sql);verifications.push(verificationMs) }
    start=performance.now();assert.deepEqual(await revisions.commitRevision(f.alice.token,input),saved)
    if (round) retries.push(performance.now()-start)
    baseRevision=saved.revision
    await leases.renewLease(f.alice.token,initial.fileId,{ editorId,leaseEpoch: lease.leaseEpoch })
  }
  t.diagnostic('P0_MEASUREMENTS '+JSON.stringify({ label: process.env.DYOFFICE_P0_LABEL ?? 'unspecified',node: process.version,bytes: bytes.length,method: 'Sequential loopback PG/RustFS; one warmup round, eight measured rounds; one authenticated owner; unchanged test pool limits. Includes SQL and storage latency, not capacity or production p95. Commit SQL count covers the service callback only; authority queries remain outside this count.',authenticate: summary(auth),putImmutable: summary(publication),commit: summary(commits),receiptRetry: summary(retries),verify: summary(verifications),commitCallbackQueries: queries,raw: { auth,publication,commits,retries,verifications } }))
})
