import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { join } from 'node:path'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'

const owned = (f, callback, token = f.alice.token) => f.transactions.withPrincipalTransaction({ kind: 'session', token }, callback)
async function revisionFixture(t, options = {}) {
  const f = await fileFixture(t, options)
  const { createLeaseService } = await import('../../server/src/modules/leases/service.ts')
  const { createRevisionService } = await import('../../server/src/modules/revisions/service.ts')
  const leases = createLeaseService({ transactions: f.transactions })
  const revisions = createRevisionService({ transactions: f.transactions, objects: f.objects, files: f.files, ...options.filePolicy })
  const original = await docxBytes(), opened = await importFile(f,f.alice.token,original)
  const editorId = randomUUID(), fileId = opened.file.fileId
  const lease = await leases.acquireLease(f.alice.token,fileId,{ editorId })
  return { ...f, leases, revisions, original, initial: opened.file, editorId, fileId, lease }
}
async function edited(original, text) {
  const zip = await JSZip.loadAsync(original)
  const xml = await zip.file('word/document.xml').async('string')
  zip.file('word/document.xml',xml.replace('</w:body>',`<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>`))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
async function stage(f, bytes, { token = f.alice.token, baseRevision = f.initial.revision, leaseEpoch = f.lease.leaseEpoch, editorId = f.editorId } = {}) {
  const upload = await f.revisions.stageUpload(token,f.fileId,{ size: bytes.length, baseRevision, leaseEpoch, editorId })
  await f.files.receiveUpload(token,upload.uploadId,bytes)
  return { fileId: f.fileId, uploadId: upload.uploadId, baseRevision, leaseEpoch, idempotencyKey: randomUUID() }
}

test('same-cookie editor instances require explicit lease takeover and stale epochs cannot renew or commit', async t => {
  const f = await revisionFixture(t), otherEditor = randomUUID()
  await assert.rejects(() => f.leases.acquireLease(f.alice.token,f.fileId,{ editorId: otherEditor }), { statusCode: 409 })
  const renewal = await f.leases.renewLease(f.alice.token,f.fileId,{ editorId: f.editorId, leaseEpoch: f.lease.leaseEpoch })
  assert.equal(renewal.leaseEpoch,f.lease.leaseEpoch)
  const bytes = await edited(f.original,'first draft'), input = await stage(f,bytes)
  const taken = await f.leases.takeoverLease(f.alice.token,f.fileId,{ editorId: otherEditor, expectedEpoch: f.lease.leaseEpoch })
  assert.ok(taken.leaseEpoch > f.lease.leaseEpoch)
  await assert.rejects(() => f.leases.renewLease(f.alice.token,f.fileId,{ editorId: f.editorId, leaseEpoch: f.lease.leaseEpoch }), { statusCode: 409 })
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token,input), { statusCode: 409 })
  assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,f.initial.revision)
})

test('saving commits one immutable revision, current pointer, receipt, quota and outbox event together', async t => {
  const f = await revisionFixture(t), bytes = await edited(f.original,'saved text'), input = await stage(f,bytes)
  const saved = await f.revisions.commitRevision(f.alice.token,input)
  assert.notEqual(saved.revision,f.initial.revision)
  assert.deepEqual((await f.files.openFile(f.alice.token,f.fileId)).file,saved)
  assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,saved.revision),bytes)
  assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,f.initial.revision),f.original)
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,f.original.length + bytes.length)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes,0)
  const counts = await owned(f, async connection => ({ receipts: (await connection.query('SELECT * FROM revision_commits')).rows, events: (await connection.query('SELECT * FROM revision_outbox')).rows }))
  assert.equal(counts.receipts.length,1); assert.equal(counts.events.length,1)
  assert.equal(counts.events[0].payload.fileId,f.fileId)
  assert.equal(counts.events[0].payload.revision,saved.revision)
  assert.equal(JSON.stringify(counts.events).includes('/objects/'),false)
})

test('two staged drafts on one base have one CAS winner and retain the losing draft', async t => {
  const f = await revisionFixture(t)
  const a = await stage(f,await edited(f.original,'draft one')), b = await stage(f,await edited(f.original,'draft two'))
  const results = await Promise.allSettled([f.revisions.commitRevision(f.alice.token,a),f.revisions.commitRevision(f.alice.token,b)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1)
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode,409)
  assert.equal((await f.revisions.listRevisions(f.alice.token,f.fileId)).revisions.length,2)
  const states = await owned(f,connection => connection.query("SELECT state FROM uploads WHERE kind='revision' ORDER BY state"))
  assert.deepEqual(states.rows.map(row => row.state),['committed','ready'])
})

test('lost-response retries return the original receipt after lease takeover and reject changed content with the same key', async t => {
  const f = await revisionFixture(t), bytes = await edited(f.original,'retry me'), input = await stage(f,bytes)
  const [first, concurrent] = await Promise.all([f.revisions.commitRevision(f.alice.token,input),f.revisions.commitRevision(f.alice.token,input)])
  assert.deepEqual(concurrent,first)
  await f.leases.takeoverLease(f.alice.token,f.fileId,{ editorId: randomUUID(), expectedEpoch: f.lease.leaseEpoch })
  assert.deepEqual(await f.revisions.commitRevision(f.alice.token,input),first)
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token,{ ...input, uploadId: randomUUID() }), { statusCode: 409 })
  const events = await owned(f,connection => connection.query('SELECT * FROM revision_outbox'))
  assert.equal(events.rowCount,1)
})

test('an outbox write failure rolls back pointer, revision, upload consumption, quota and receipt while preserving the object', async t => {
  const f = await revisionFixture(t), bytes = await edited(f.original,'rollback text'), input = await stage(f,bytes)
  await f.ownerPool.query("CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled outbox failure'; END $$")
  await f.ownerPool.query('CREATE TRIGGER reject_outbox BEFORE INSERT ON revision_outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox()')
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token,input), { code: 'P0001' })
  assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,f.initial.revision)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes,bytes.length)
  assert.equal((await f.revisions.listRevisions(f.alice.token,f.fileId)).revisions.length,1)
  assert.equal((await owned(f,connection => connection.query('SELECT * FROM revision_commits'))).rowCount,0)
  assert.equal((await readdir(f.directory)).length,2)
  await f.ownerPool.query('DROP TRIGGER reject_outbox ON revision_outbox')
  assert.equal((await f.revisions.commitRevision(f.alice.token,input)).size,bytes.length)
})

test('historical restore stages a verified new object and commits a new child of the current revision', async t => {
  const f = await revisionFixture(t), changed = await edited(f.original,'later change'), input = await stage(f,changed)
  const saved = await f.revisions.commitRevision(f.alice.token,input)
  const restore = await f.revisions.stageRestore(f.alice.token,f.fileId,{ revision: f.initial.revision, baseRevision: saved.revision, leaseEpoch: f.lease.leaseEpoch, editorId: f.editorId })
  assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,saved.revision)
  const restored = await f.revisions.commitRevision(f.alice.token,{ fileId: f.fileId, uploadId: restore.uploadId, baseRevision: saved.revision, leaseEpoch: f.lease.leaseEpoch, idempotencyKey: randomUUID() })
  assert.notEqual(restored.revision,f.initial.revision); assert.notEqual(restored.revision,saved.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,restored.revision),f.original)
  const history = (await f.revisions.listRevisions(f.alice.token,f.fileId)).revisions
  assert.equal(history.length,3)
  const row = history.find(row => row.revision === restored.revision)
  assert.equal(row.source,'restore'); assert.equal(row.parentRevision,saved.revision); assert.equal(row.restoredFrom,f.initial.revision)
})

function headers(f, token = f.alice.token) {
  return import('../../server/src/modules/auth/csrf.ts').then(({ createCsrfService }) => {
    const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: 'https://office.example', key: f.csrfKey })
    return { origin: 'https://office.example', cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token) }
  })
}
test('versioned lease/stage/commit/history API validates SaveInput and preserves browser-safe byte delivery', async t => {
  const f = await revisionFixture(t), h = await headers(f), bytes = await edited(f.original,'HTTP save')
  // The helper acquired a server-side lease. The HTTP actor can renew that exact editor.
  const base = '/api/v1/files/' + f.fileId
  assert.equal((await f.app.inject({ method: 'POST', url: base + '/lease/renew', headers: h, payload: { editorId: f.editorId, leaseEpoch: f.lease.leaseEpoch } })).statusCode,200)
  const staged = await f.app.inject({ method: 'POST', url: base + '/uploads', headers: h, payload: { size: bytes.length, baseRevision: f.initial.revision, leaseEpoch: f.lease.leaseEpoch, editorId: f.editorId } })
  assert.equal(staged.statusCode,201)
  const upload = staged.json()
  const received = await f.app.inject({ method: 'PUT', url: '/api/v1/uploads/' + upload.uploadId + '/content', headers: { ...h,'content-type': 'application/octet-stream' }, payload: bytes })
  assert.equal(received.statusCode,200)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/uploads/' + upload.uploadId + '/finish', headers: h })).statusCode,409)
  const input = { fileId: f.fileId, uploadId: upload.uploadId, baseRevision: f.initial.revision, leaseEpoch: f.lease.leaseEpoch, idempotencyKey: randomUUID() }
  assert.equal((await f.app.inject({ method: 'POST', url: base + '/commits', headers: h, payload: { ...input, ownerId: f.bob.user.id } })).statusCode,400)
  assert.equal((await f.app.inject({ method: 'POST', url: base + '/commits', headers: { ...h,origin: 'https://evil.example' }, payload: input })).statusCode,403)
  const result = await f.app.inject({ method: 'POST', url: base + '/commits', headers: h, payload: input })
  assert.equal(result.statusCode,200)
  assert.deepEqual((await f.app.inject({ method: 'POST', url: base + '/commits', headers: h, payload: input })).json(),result.json())
  const history = await f.app.inject({ method: 'GET', url: base + '/revisions?limit=1', headers: h })
  assert.equal(history.statusCode,200); assert.equal(history.json().revisions.length,1); assert.ok(history.json().nextCursor)
  const download = await f.app.inject({ method: 'GET', url: base + '/content?revision=' + result.json().revision, headers: h })
  assert.equal(download.statusCode,200); assert.deepEqual(download.rawPayload,bytes)
})

test('another login session cannot use a held lease or an upload captured by the first session', async t => {
  const f = await revisionFixture(t), bytes = await edited(f.original,'bound to session'), input = await stage(f,bytes)
  const { password } = await import('../helpers/identity.mjs'), other = await f.sessions.login('alice',password)
  await assert.rejects(() => f.leases.acquireLease(other.token,f.fileId,{ editorId: f.editorId }), { statusCode: 409 })
  await assert.rejects(() => f.leases.renewLease(other.token,f.fileId,{ editorId: f.editorId, leaseEpoch: f.lease.leaseEpoch }), { statusCode: 409 })
  await assert.rejects(() => f.revisions.commitRevision(other.token,input), { statusCode: 409 })
  const taken = await f.leases.takeoverLease(other.token,f.fileId,{ editorId: randomUUID(), expectedEpoch: f.lease.leaseEpoch })
  assert.ok(taken.leaseEpoch > f.lease.leaseEpoch)
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token,input), { statusCode: 409 })
})

test('B/Admin cannot read history, acquire leases or commit guessed A uploads and append-only tables enforce RLS', async t => {
  const f = await revisionFixture(t), input = await stage(f,await edited(f.original,'private revision'))
  await f.revisions.commitRevision(f.alice.token,input)
  for (const token of [f.bob.token,f.adminSigned.token]) {
    await assert.rejects(() => f.leases.getLease(token,f.fileId), { statusCode: 404 })
    await assert.rejects(() => f.leases.acquireLease(token,f.fileId,{ editorId: randomUUID() }), { statusCode: 404 })
    await assert.rejects(() => f.revisions.listRevisions(token,f.fileId), { statusCode: 404 })
    await assert.rejects(() => f.revisions.commitRevision(token,input), { statusCode: 404 })
  }
  for (const table of ['edit_leases','revision_commits','revision_outbox']) {
    assert.equal((await f.businessPool.query('SELECT * FROM ' + table)).rowCount,0)
    await assert.rejects(() => f.authPool.query('SELECT * FROM ' + table), { code: '42501' })
  }
  await assert.rejects(() => owned(f,connection => connection.query("UPDATE revision_commits SET request_hash=repeat('0',64)")), { code: '42501' })
  await assert.rejects(() => owned(f,connection => connection.query('DELETE FROM revision_outbox')), { code: '42501' })
})

test('history pagination preserves revisions whose database timestamps differ only by microseconds', async t => {
  const f = await revisionFixture(t)
  const a = await f.revisions.commitRevision(f.alice.token,await stage(f,await edited(f.original,'micro one')))
  const b = await f.revisions.commitRevision(f.alice.token,await stage(f,await edited(f.original,'micro two'),{ baseRevision: a.revision }))
  await f.ownerDb.transaction(async connection => {
    await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)",[f.deploymentId,f.alice.user.id])
    for (const [index, revision] of [f.initial.revision,a.revision,b.revision].entries()) {
      await connection.query("UPDATE file_revisions SET created_at='2026-11-15 10:00:00+00'::timestamptz+$1*interval '1 microsecond' WHERE deployment_id=$2 AND owner_id=$3 AND file_id=$4 AND id=$5",[index+1,f.deploymentId,f.alice.user.id,f.fileId,revision])
    }
  })
  const seen = [], cursorLimit = 1
  let cursor
  do {
    const page = await f.revisions.listRevisions(f.alice.token,f.fileId,{ limit: cursorLimit, cursor })
    seen.push(...page.revisions.map(row => row.revision)); cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(seen,[b.revision,a.revision,f.initial.revision])
})

test('canonical deployment UUID casing cannot break immutable object namespace generation', async t => {
  const f = await revisionFixture(t)
  const { createPrincipalTransactions } = await import('../../server/src/db/context.ts')
  const { createFileService } = await import('../../server/src/modules/files/service.ts')
  const transactions = createPrincipalTransactions({ pool: f.businessPool, deploymentId: f.deploymentId.toUpperCase() })
  const files = createFileService({ transactions, objects: f.objects })
  const opened = await importFile({ ...f, files },f.alice.token,f.original,'uppercase.docx')
  assert.deepEqual(await files.readFile(f.alice.token,opened.file.fileId,opened.file.revision),f.original)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
for (const boundary of ['lease','upload']) test(`${boundary} expiry during real object verification rolls back the save transaction`, { timeout: 15_000 }, async t => {
  const f = await revisionFixture(t), bytes = await edited(f.original,'expires during verification'), input = await stage(f,bytes)
  const { createRevisionService } = await import('../../server/src/modules/revisions/service.ts')
  const ready = deferred(), release = deferred()
  const gated = createRevisionService({ transactions: f.transactions, files: f.files, objects: { ...f.objects, async verifyObject(reference) {
    const result = await f.objects.verifyObject(reference)
    ready.resolve(); await release.promise
    return result
  } } })
  await owned(f,connection => boundary === 'lease'
    ? connection.query("UPDATE edit_leases SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3",[f.deploymentId,f.alice.user.id,f.fileId])
    : connection.query("UPDATE uploads SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE deployment_id=$1 AND owner_id=$2 AND id=$3",[f.deploymentId,f.alice.user.id,input.uploadId]))
  const saving = gated.commitRevision(f.alice.token,input).then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([ready.promise,saving.then(() => { throw new Error('Save ended before object barrier') })])
    await f.admin.query('SELECT pg_sleep(0.6)')
    release.resolve()
    assert.equal((await saving).error?.statusCode,boundary === 'lease' ? 409 : 410)
    assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,f.initial.revision)
    assert.equal((await owned(f,connection => connection.query('SELECT * FROM revision_commits'))).rowCount,0)
    assert.equal((await owned(f,connection => connection.query('SELECT * FROM revision_outbox'))).rowCount,0)
  } finally { release.resolve(); await saving }
})

test('concurrent takeovers compare their expected epoch and release/reacquire never reuses an epoch', async t => {
  const f = await revisionFixture(t), a = randomUUID(), b = randomUUID()
  const taken = await Promise.allSettled([f.leases.takeoverLease(f.alice.token,f.fileId,{ editorId: a, expectedEpoch: f.lease.leaseEpoch }),f.leases.takeoverLease(f.alice.token,f.fileId,{ editorId: b, expectedEpoch: f.lease.leaseEpoch })])
  assert.equal(taken.filter(result => result.status === 'fulfilled').length,1)
  assert.equal(taken.find(result => result.status === 'rejected').reason.statusCode,409)
  const winner = taken.find(result => result.status === 'fulfilled').value
  await f.leases.releaseLease(f.alice.token,f.fileId,{ editorId: winner.editorId, leaseEpoch: winner.leaseEpoch })
  await assert.rejects(() => f.leases.renewLease(f.alice.token,f.fileId,{ editorId: winner.editorId, leaseEpoch: winner.leaseEpoch }), { statusCode: 409 })
  const next = await f.leases.acquireLease(f.alice.token,f.fileId,{ editorId: winner.editorId })
  assert.ok(next.leaseEpoch > winner.leaseEpoch)
})

test('recycle/restore fences old drafts and committed-key replay survives a later current revision', async t => {
  const f = await revisionFixture(t), firstInput = await stage(f,await edited(f.original,'first committed'))
  const first = await f.revisions.commitRevision(f.alice.token,firstInput)
  const pending = await stage(f,await edited(f.original,'old draft'),{ baseRevision: first.revision })
  await f.files.trashFile(f.alice.token,f.fileId)
  await f.files.restoreFile(f.alice.token,f.fileId)
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token,pending), { statusCode: 409 })
  const lease = await f.leases.acquireLease(f.alice.token,f.fileId,{ editorId: f.editorId })
  const laterInput = await stage(f,await edited(f.original,'later committed'),{ baseRevision: first.revision, leaseEpoch: lease.leaseEpoch })
  const later = await f.revisions.commitRevision(f.alice.token,laterInput)
  assert.deepEqual(await f.revisions.commitRevision(f.alice.token,firstInput),first)
  assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,later.revision)
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token,{ ...firstInput, sourceCommandId: randomUUID() }), { statusCode: 409 })
})

test('real S3-backed save keeps old and new objects readable and retries without overwriting', async t => {
  const { s3Fixture } = await import('../helpers/s3.mjs'), remote = await s3Fixture(t)
  const f = await revisionFixture(t,{ objectStore: remote.store }), bytes = await edited(f.original,'S3 committed revision'), input = await stage(f,bytes)
  const saved = await f.revisions.commitRevision(f.alice.token,input)
  assert.deepEqual(await f.revisions.commitRevision(f.alice.token,input),saved)
  assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,f.initial.revision),f.original)
  assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,saved.revision),bytes)
})

test('initial import finish retry returns its original revision after a later save advances the head', async t => {
  const f = await revisionFixture(t)
  const imported = (await owned(f,connection => connection.query("SELECT id FROM uploads WHERE file_id=$1 AND kind='import'",[f.fileId]))).rows[0].id
  const saved = await f.revisions.commitRevision(f.alice.token,await stage(f,await edited(f.original,'head advanced')))
  assert.notEqual(saved.revision,f.initial.revision)
  const replay = await f.files.finishUpload(f.alice.token,imported)
  assert.deepEqual(replay.file,f.initial)
  assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,replay.file.revision),f.original)
})


test('same-size corruption of a ready save object prevents all new references and keeps the current version intact', async t => {
  const f = await revisionFixture(t), bytes = await edited(f.original,'object corruption'), input = await stage(f,bytes)
  let corrupted = false
  for (const filename of await readdir(f.directory)) {
    const path = join(f.directory,filename)
    if ((await readFile(path)).equals(bytes)) { await writeFile(path,Buffer.alloc(bytes.length,65)); corrupted = true }
  }
  assert.equal(corrupted,true)
  await assert.rejects(() => f.revisions.commitRevision(f.alice.token,input), { statusCode: 503 })
  assert.deepEqual((await f.files.openFile(f.alice.token,f.fileId)).file,f.initial)
  assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,f.initial.revision),f.original)
  assert.equal((await owned(f,connection => connection.query('SELECT * FROM revision_commits'))).rowCount,0)
  assert.equal((await owned(f,connection => connection.query('SELECT * FROM revision_outbox'))).rowCount,0)
})

test('personal revision staging reclaims cancelled completed drafts without touching history',async t=>{
 const bytes=await docxBytes(),f=await revisionFixture(t,{filePolicy:{quotaBytes:bytes.length*2}})
 const first=await stage(f,bytes)
 await f.files.cancelUpload(f.alice.token,first.uploadId)
 assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length*2)
 const second=await f.revisions.stageUpload(f.alice.token,f.fileId,{size:bytes.length,baseRevision:f.initial.revision,leaseEpoch:f.lease.leaseEpoch,editorId:f.editorId})
 assert.ok(second.uploadId)
 const usage=await f.files.usage(f.alice.token)
 assert.equal(usage.storedBytes,bytes.length);assert.equal(usage.reservedBytes,bytes.length)
 assert.deepEqual(await f.files.readFile(f.alice.token,f.fileId,f.initial.revision),bytes)
})

test('finish and commit verify integrity without collecting object payloads', async t => {
  let verified = 0
  const f = await revisionFixture(t, { wrapObjects: base => ({ ...base,
    readVerified() { throw new Error('unexpected full object collection') },
    async verifyObject(reference) { await base.verifyObject(reference); verified++ },
  }) })
  assert.equal(verified, 1)
  const input = await stage(f, await edited(f.original, 'bounded verification'))
  const saved = await f.revisions.commitRevision(f.alice.token, input)
  assert.equal(verified, 2)
  assert.notEqual(saved.revision, f.initial.revision)
  assert.deepEqual(await f.revisions.commitRevision(f.alice.token, input), saved)
  assert.equal(verified, 2)
})
