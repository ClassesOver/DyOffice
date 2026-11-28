import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument } from 'pdf-lib'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { restrictedOrigin } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { objectTransferAdmission } from '../../server/src/modules/files/transfer-admission.ts'
import { password } from '../helpers/identity.mjs'

const credential = token => ({ kind: 'session', token })
const own = (f, callback) => f.transactions.withPrincipalTransaction(credential(f.alice.token), callback)

test('duplicate publishes exactly one independent copy in the source folder and can recover the finish receipt', async t => {
  const f=await fileFixture(t),bytes=await docxBytes()
  const source=await importFile(f,f.alice.token,bytes,'report.docx')
  const id=source.file.fileId
  const {createWorkspaceService}=await import('../../server/src/modules/workspace/service.ts')
  const workspace=createWorkspaceService(f.transactions)
  const folder=await workspace.createFolder(f.alice.token,{name:'Reports',parentId:null})
  await workspace.moveFile(f.alice.token,id,{folderId:folder.id})
  await workspace.setStar(f.alice.token,id,{starred:true})
  await assert.rejects(()=>f.files.prepareDuplicate(f.bob.token,id),{statusCode:404})
  const pending=await f.files.prepareDuplicate(f.alice.token,id)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
  const finish=()=>f.files.finishDuplicate(f.alice.token,id,pending.uploadId,pending.revision,'en')
  const [copy,retry]=await Promise.all([finish(),finish()])
  assert.equal(copy.name,'report Copy.docx')
  assert.deepEqual(copy,retry)
  assert.notEqual(copy.file.fileId,id)
  assert.notEqual(copy.file.revision,source.file.revision)
  assert.deepEqual(await f.files.readFile(f.alice.token,copy.file.fileId,copy.file.revision),bytes)
  assert.deepEqual(await f.files.openFile(f.alice.token,id),source)
  const copied=(await workspace.listFiles(f.alice.token,{view:'all',id:copy.file.fileId})).files[0]
  assert.equal(copied.folderId,folder.id)
  assert.equal(copied.starred,false)
  const next=await f.files.prepareDuplicate(f.alice.token,id)
  assert.equal((await f.files.finishDuplicate(f.alice.token,id,next.uploadId,next.revision,'en')).name,'report Copy 2.docx')
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length*3)
})

test('four-format import publishes exact originals only after explicit finish and never leaks object keys', async t => {
  const f = await fileFixture(t)
  for (const [path, name] of [
    ['packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx','report.docx'],
    ['apps/shell/build/shell-new/blank.xlsx','sheet.xlsx'],
    ['packages/pptx-engine/tests/fixtures/01_standard_business.pptx','slides.pptx'],
    ['apps/pdf/tests/fixtures/plain-sample.pdf','paper.pdf'],
  ]) {
    const bytes = await readFile(new URL('../../../../' + path, import.meta.url))
    const pending = await f.files.stageUpload(f.alice.token, { name, size: bytes.length })
    await assert.rejects(() => f.files.openFile(f.alice.token, pending.fileId), { statusCode: 404 })
    await assert.rejects(() => f.files.finishUpload(f.alice.token, pending.uploadId), { statusCode: 409 })
    const ready = await f.files.receiveUpload(f.alice.token, pending.uploadId, bytes)
    assert.equal(ready.sha256, createHash('sha256').update(bytes).digest('hex'))
    await assert.rejects(() => f.files.openFile(f.alice.token, pending.fileId), { statusCode: 404 })
    const opened = await f.files.finishUpload(f.alice.token, pending.uploadId)
    assert.deepEqual(await f.files.finishUpload(f.alice.token, pending.uploadId), opened)
    assert.equal(opened.file.fileId, pending.fileId)
    assert.equal(opened.file.size, bytes.length)
    assert.ok(Object.values(opened.capabilities).every(value => value === 'unsupported'))
    assert.deepEqual(await f.files.readFile(f.alice.token, pending.fileId, opened.file.revision), bytes)
    assert.equal(JSON.stringify({ pending, ready, opened }).includes('/objects/'), false)
  }
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 4)
})

test('A/B/Admin cannot guess upload, file or revision ownership and raw SQL enforces file RLS', async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const upload = await f.files.stageUpload(f.alice.token, { name: 'a.docx', size: bytes.length })
  for (const token of [f.bob.token, f.adminSigned.token]) {
    await assert.rejects(() => f.files.receiveUpload(token, upload.uploadId, bytes), { statusCode: 404 })
    await assert.rejects(() => f.files.finishUpload(token, upload.uploadId), { statusCode: 404 })
    await assert.rejects(() => f.files.cancelUpload(token, upload.uploadId), { statusCode: 404 })
  }
  await f.files.receiveUpload(f.alice.token, upload.uploadId, bytes)
  const file = await f.files.finishUpload(f.alice.token, upload.uploadId)
  const b = await importFile(f, f.bob.token, bytes)
  for (const token of [f.bob.token, f.adminSigned.token]) {
    await assert.rejects(() => f.files.openFile(token, file.file.fileId), { statusCode: 404 })
    await assert.rejects(() => f.files.readFile(token, file.file.fileId, file.file.revision), { statusCode: 404 })
    await assert.rejects(() => f.files.trashFile(token, file.file.fileId), { statusCode: 404 })
  }
  await assert.rejects(() => f.files.readFile(f.alice.token, file.file.fileId, b.file.revision), { statusCode: 404 })
  for (const table of ['files','uploads','file_revisions','storage_accounts']) {
    assert.equal((await f.businessPool.query('SELECT * FROM ' + table)).rowCount, 0)
    await assert.rejects(() => f.authPool.query('SELECT * FROM ' + table), { code: '42501' })
  }
  await assert.rejects(() => own(f, connection => connection.query('UPDATE files SET owner_id=$1', [f.bob.user.id])), { code: '42501' })
  await assert.rejects(() => own(f, connection => connection.query('UPDATE files SET current_revision=$1', [b.file.revision])), { code: '23503' })
})

test('quota reservations serialize concurrent stages and trash retains stored usage', async t => {
  const bytes = await docxBytes(), f = await fileFixture(t, { filePolicy: { quotaBytes: bytes.length * 2 - 1 } })
  const staged = await Promise.allSettled([f.files.stageUpload(f.alice.token, { name: 'a.docx', size: bytes.length }),f.files.stageUpload(f.alice.token, { name: 'b.docx', size: bytes.length })])
  assert.equal(staged.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(staged.find(result => result.status === 'rejected').reason.statusCode, 413)
  const upload = staged.find(result => result.status === 'fulfilled').value
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes, bytes.length)
  await f.files.receiveUpload(f.alice.token, upload.uploadId, bytes)
  const file = await f.files.finishUpload(f.alice.token, upload.uploadId)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes, 0)
  await f.files.trashFile(f.alice.token, file.file.fileId)
  assert.equal((await f.files.usage(f.alice.token)).storedBytes, bytes.length)
  await assert.rejects(() => f.files.stageUpload(f.alice.token, { name: 'c.docx', size: bytes.length }), { statusCode: 413 })
})

test('invalid bytes, size mismatch and abandoned uploads cannot become files or retain pre-write reservations', async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  for (const name of ['../x.docx','x.exe']) await assert.rejects(() => f.files.stageUpload(f.alice.token, { name, size: bytes.length }), { statusCode: 400 })
  for (const size of [0, -1, 33 * 1024 * 1024, 1.2]) await assert.rejects(() => f.files.stageUpload(f.alice.token, { name: 'x.docx', size }))
  for (const payload of [Buffer.from('not an office file'), Buffer.alloc(bytes.length, 65)]) {
    const upload = await f.files.stageUpload(f.alice.token, { name: 'x.docx', size: bytes.length })
    await assert.rejects(() => f.files.receiveUpload(f.alice.token, upload.uploadId, payload), { statusCode: 400 })
    await assert.rejects(() => f.files.finishUpload(f.alice.token, upload.uploadId))
  }
  const abandoned = await f.files.stageUpload(f.alice.token, { name: 'x.docx', size: bytes.length })
  await f.files.cancelUpload(f.alice.token, abandoned.uploadId)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes, 0)
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 0)
  assert.deepEqual(await readdir(f.directory), [])
})

test('object success followed by database failure leaves no file reference and a finish retry uses the same immutable object', async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const upload = await f.files.stageUpload(f.alice.token, { name: 'x.docx', size: bytes.length })
  await f.files.receiveUpload(f.alice.token, upload.uploadId, bytes)
  await f.ownerPool.query("CREATE FUNCTION reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled import failure'; END $$")
  await f.ownerPool.query('CREATE TRIGGER reject_import BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION reject_import()')
  await assert.rejects(() => f.files.finishUpload(f.alice.token, upload.uploadId), { code: 'P0001' })
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 0)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes, bytes.length)
  assert.equal((await readdir(f.directory)).length, 1)
  await f.ownerPool.query('DROP TRIGGER reject_import ON files')
  const opened = await f.files.finishUpload(f.alice.token, upload.uploadId)
  assert.deepEqual(await f.files.readFile(f.alice.token, opened.file.fileId, opened.file.revision), bytes)
  assert.equal((await readdir(f.directory)).length, 1)
})

test('finish refuses a missing or same-size-corrupted staged object without committing file metadata', async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const upload = await f.files.stageUpload(f.alice.token, { name: 'x.docx', size: bytes.length })
  await f.files.receiveUpload(f.alice.token, upload.uploadId, bytes)
  const [name] = await readdir(f.directory)
  await writeFile(join(f.directory, name), Buffer.alloc(bytes.length, 65))
  await assert.rejects(() => f.files.finishUpload(f.alice.token, upload.uploadId), { statusCode: 503 })
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 0)
})

test('rename, recycle and restore preserve revision bytes and scoped pagination', async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const otherBytes = await readFile(new URL('../../../../apps/shell/build/shell-new/blank.docx', import.meta.url))
  const name = '重命名.docx'
  const a = await importFile(f, f.alice.token, bytes), b = await importFile(f, f.alice.token, otherBytes, name)
  assert.notEqual(a.file.sha256, b.file.sha256)
  const first = await f.files.listFiles(f.alice.token, { limit: 1 })
  assert.equal(first.files.length, 1); assert.ok(first.nextCursor)
  const next = await f.files.listFiles(f.alice.token, { limit: 1, cursor: first.nextCursor })
  assert.equal(next.files.length, 1); assert.notEqual(first.files[0].id, next.files[0].id)
  await f.files.renameFile(f.alice.token, a.file.fileId, name)
  for (const invalid of ['wrong.pdf', '../report.docx', 'folder\\report.docx']) {
    await assert.rejects(() => f.files.renameFile(f.alice.token, a.file.fileId, invalid), { statusCode: 400 })
  }
  for (const token of [f.bob.token, f.adminSigned.token]) {
    await assert.rejects(() => f.files.renameFile(token, a.file.fileId, 'other.docx'), { statusCode: 404 })
  }
  await f.files.trashFile(f.alice.token, a.file.fileId)
  await assert.rejects(() => f.files.openFile(f.alice.token, a.file.fileId), { statusCode: 404 })
  await assert.rejects(() => f.files.readFile(f.alice.token, a.file.fileId, a.file.revision), { statusCode: 404 })
  assert.equal((await f.files.listFiles(f.alice.token, { trash: true })).files[0].name, name)
  assert.equal((await f.files.listFiles(f.alice.token)).files[0].id, b.file.fileId)
  await f.files.restoreFile(f.alice.token, a.file.fileId)
  for (const [opened, original] of [[a, bytes], [b, otherBytes]]) {
    const current = await f.files.openFile(f.alice.token, opened.file.fileId)
    assert.equal(current.name, name)
    assert.equal(current.file.revision, opened.file.revision)
    assert.deepEqual(await f.files.readFile(f.alice.token, current.file.fileId, current.file.revision), original)
  }
})

function signedHeaders(f, token = f.alice.token) {
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  return { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token) }
}
test('versioned HTTP upload/open/download enforces cookies, CSRF, strict schemas and private binary delivery', async t => {
  const f = await fileFixture(t), bytes = await docxBytes(), headers = signedHeaders(f)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/files/uploads', payload: { name: 'a.docx', size: bytes.length } })).statusCode, 401)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/files/uploads', headers: { ...headers, origin: 'https://evil.example' }, payload: { name: 'a.docx', size: bytes.length } })).statusCode, 403)
  for (const payload of [{ name: 'a.docx', size: bytes.length, ownerId: f.bob.user.id },{ name: 'a.docx', size: String(bytes.length) }]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/files/uploads', headers, payload })).statusCode, 400)
  }
  const staged = await f.app.inject({ method: 'POST', url: '/api/v1/files/uploads', headers, payload: { name: '下载.docx', size: bytes.length } })
  assert.equal(staged.statusCode, 201)
  const upload = staged.json(), base = '/api/v1/uploads/' + upload.uploadId
  assert.equal((await f.app.inject({ method: 'POST', url: base + '/finish', headers })).statusCode, 409)
  const received = await f.app.inject({ method: 'PUT', url: base + '/content', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
  assert.equal(received.statusCode, 200)
  const finished = await f.app.inject({ method: 'POST', url: base + '/finish', headers })
  assert.equal(finished.statusCode, 200)
  const opened = finished.json()
  const download = await f.app.inject({ method: 'GET', url: opened.downloadEndpoint, headers })
  assert.equal(download.statusCode, 200); assert.deepEqual(download.rawPayload, bytes)
  assert.equal(download.headers['content-type'], 'application/octet-stream')
  assert.match(download.headers['cache-control'], /no-store/)
  assert.match(download.headers['content-disposition'], /^attachment;/)
  assert.match(download.headers['content-disposition'], /filename\*=UTF-8''/)
  const denied = await f.app.inject({ method: 'GET', url: opened.downloadEndpoint, headers: signedHeaders(f, f.bob.token) })
  assert.equal(denied.statusCode, 404); assert.equal(denied.body.includes('下载'), false)
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/files?ownerId=' + f.bob.user.id, headers })).statusCode, 400)
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/files/' + upload.fileId + '/content', headers })).statusCode, 400)
})

test('cancelled or expired published objects retain quota until reference-aware collection', async t => {
  const bytes = await docxBytes(), f = await fileFixture(t, { filePolicy: { quotaBytes: bytes.length } })
  const upload = await f.files.stageUpload(f.alice.token, { name: 'a.docx', size: bytes.length })
  await f.files.receiveUpload(f.alice.token, upload.uploadId, bytes)
  await f.files.cancelUpload(f.alice.token, upload.uploadId)
  const usage = await f.files.usage(f.alice.token)
  assert.equal(usage.reservedBytes, 0); assert.equal(usage.storedBytes, bytes.length)
  const next = await f.files.stageUpload(f.alice.token, { name: 'b.docx', size: bytes.length })
  assert.ok(next.uploadId)
  const after = await f.files.usage(f.alice.token)
  assert.equal(after.storedBytes, 0); assert.equal(after.reservedBytes, bytes.length)
  assert.equal((await readdir(f.directory)).length, 0)
})

test('expired empty stages free reservations while receiving/ready stages conservatively retain object capacity', async t => {
  const bytes = await docxBytes(), f = await fileFixture(t, { filePolicy: { maxUploads: 1 } })
  const empty = await f.files.stageUpload(f.alice.token, { name: 'empty.docx', size: bytes.length })
  await assert.rejects(() => f.files.stageUpload(f.alice.token, { name: 'limit.docx', size: bytes.length }), { statusCode: 429 })
  const expire = id => own(f, connection => connection.query("UPDATE uploads SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1 AND deployment_id=$2 AND owner_id=$3", [id,f.deploymentId,f.alice.user.id]))
  await expire(empty.uploadId)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes, 0)
  await assert.rejects(() => f.files.finishUpload(f.alice.token, empty.uploadId), { statusCode: 410 })
  const ready = await f.files.stageUpload(f.alice.token, { name: 'ready.docx', size: bytes.length })
  await f.files.receiveUpload(f.alice.token, ready.uploadId, bytes)
  await expire(ready.uploadId)
  const usage = await f.files.usage(f.alice.token)
  assert.equal(usage.reservedBytes, 0); assert.equal(usage.storedBytes, bytes.length)
  await assert.rejects(() => f.files.finishUpload(f.alice.token, ready.uploadId), { statusCode: 410 })
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
test('revocation after real object publication prevents ready/finish metadata from committing', { timeout: 15_000 }, async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const { createFileService } = await import('../../server/src/modules/files/service.ts')
  const ready = deferred(), release = deferred()
  const gated = createFileService({ transactions: f.transactions, objects: { ...f.objects, async putImmutable(key, data) {
    const result = await f.objects.putImmutable(key,data)
    ready.resolve(); await release.promise
    return result
  } } })
  const upload = await gated.stageUpload(f.alice.token, { name: 'revoked.docx', size: bytes.length })
  const receiving = gated.receiveUpload(f.alice.token, upload.uploadId, bytes).then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([ready.promise, receiving.then(() => { throw new Error('Receiver ended before object barrier') })])
    await f.users.update(f.adminSigned.token, f.alice.user.id, { status: 'disabled' })
    release.resolve()
    assert.equal((await receiving).error?.statusCode, 401)
    await assert.rejects(() => f.files.finishUpload(f.alice.token, upload.uploadId), { statusCode: 401 })
    assert.equal((await readdir(f.directory)).length, 1)
    assert.equal((await f.files.listFiles(f.adminSigned.token)).files.length, 0)
    await f.users.update(f.adminSigned.token, f.alice.user.id, { status: 'active' })
    const { password } = await import('../helpers/identity.mjs')
    const fresh = await f.sessions.login('alice',password)
    assert.equal((await f.files.listFiles(fresh.token)).files.length, 0)
    await assert.rejects(() => f.files.finishUpload(fresh.token, upload.uploadId), { statusCode: 409 })
  } finally { release.resolve(); await receiving }
})

test('an aborted HTTP byte transfer preserves the empty stage and can be retried without creating a file', { timeout: 15_000 }, async t => {
  const f = await fileFixture(t), bytes = await docxBytes(), headers = signedHeaders(f)
  const upload = await f.files.stageUpload(f.alice.token, { name: 'interrupted.docx', size: bytes.length })
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' })
  const { request } = await import('node:http')
  const req = request(address + '/api/v1/uploads/' + upload.uploadId + '/content', { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': bytes.length } })
  req.on('error', () => {})
  const closed = new Promise(resolve => req.once('close',resolve))
  req.write(bytes.subarray(0,10))
  await new Promise(resolve => req.once('socket', socket => socket.connecting ? socket.once('connect',resolve) : resolve()))
  req.destroy()
  await closed
  assert.equal((await f.files.listFiles(f.alice.token)).files.length, 0)
  assert.equal((await f.files.usage(f.alice.token)).reservedBytes, bytes.length)
  assert.deepEqual(await readdir(f.directory), [])
  const reply = await f.app.inject({ method: 'PUT', url: '/api/v1/uploads/' + upload.uploadId + '/content', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
  assert.equal(reply.statusCode,200)
  assert.equal((await f.files.finishUpload(f.alice.token, upload.uploadId)).file.size,bytes.length)
})

test('upload ownership and declared byte count are checked before raw-body buffering', async t => {
  const f = await fileFixture(t), bytes = await docxBytes(), headers = signedHeaders(f)
  const unknown = await f.app.inject({ method: 'PUT', url: '/api/v1/uploads/' + randomUUID() + '/content', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': 33 * 1024 * 1024 }, payload: 'x' })
  assert.equal(unknown.statusCode,404)
  const upload = await f.files.stageUpload(f.alice.token, { name: 'small.docx', size: bytes.length })
  const forbidden = await f.app.inject({ method: 'PUT', url: '/api/v1/uploads/' + upload.uploadId + '/content', headers: { ...signedHeaders(f, f.bob.token), 'content-type': 'application/octet-stream' }, payload: bytes })
  assert.equal(forbidden.statusCode,404)
  const mismatch = await f.app.inject({ method: 'PUT', url: '/api/v1/uploads/' + upload.uploadId + '/content', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': bytes.length + 1 }, payload: 'x' })
  assert.equal(mismatch.statusCode,400)
})

test('real S3-backed import commits a scoped immutable reference and downloads exact bytes', async t => {
  const { s3Fixture } = await import('../helpers/s3.mjs')
  const remote = await s3Fixture(t), f = await fileFixture(t, { objectStore: remote.store }), bytes = await docxBytes()
  const opened = await importFile(f, f.alice.token, bytes, 'remote.docx')
  assert.deepEqual(await f.files.readFile(f.alice.token, opened.file.fileId, opened.file.revision), bytes)
  await assert.rejects(() => f.files.readFile(f.bob.token, opened.file.fileId, opened.file.revision), { statusCode: 404 })
  assert.equal((await f.files.usage(f.alice.token)).storedBytes, bytes.length)
})

test('session expiry while finish reads the real object rolls back file and quota commit', { timeout: 15_000 }, async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const { createFileService } = await import('../../server/src/modules/files/service.ts')
  const upload = await f.files.stageUpload(f.alice.token, { name: 'expiry.docx', size: bytes.length })
  await f.files.receiveUpload(f.alice.token, upload.uploadId, bytes)
  const ready = deferred(), release = deferred()
  const gated = createFileService({ transactions: f.transactions, objects: { ...f.objects, async verifyObject(reference) {
    const result = await f.objects.verifyObject(reference)
    ready.resolve(); await release.promise
    return result
  } } })
  await f.authPool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [f.alice.sessionId])
  const finishing = gated.finishUpload(f.alice.token, upload.uploadId).then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([ready.promise, finishing.then(() => { throw new Error('Finisher ended before object barrier') })])
    await f.admin.query('SELECT pg_sleep(0.6)')
    release.resolve()
    assert.equal((await finishing).error?.statusCode,401)
    const { password } = await import('../helpers/identity.mjs'), fresh = await f.sessions.login('alice',password)
    assert.equal((await f.files.listFiles(fresh.token)).files.length,0)
    assert.equal((await f.files.usage(fresh.token)).reservedBytes,bytes.length)
  } finally { release.resolve(); await finishing }
})

test('upload expiry while finish verifies the object rolls back metadata and retains object capacity', { timeout: 15_000 }, async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const { createFileService } = await import('../../server/src/modules/files/service.ts')
  const upload = await f.files.stageUpload(f.alice.token, { name: 'expired.docx', size: bytes.length })
  await f.files.receiveUpload(f.alice.token, upload.uploadId, bytes)
  await own(f, connection => connection.query("UPDATE uploads SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE deployment_id=$1 AND owner_id=$2 AND id=$3", [f.deploymentId,f.alice.user.id,upload.uploadId]))
  const ready = deferred(), release = deferred()
  const gated = createFileService({ transactions: f.transactions, objects: { ...f.objects, async verifyObject(reference) {
    const result = await f.objects.verifyObject(reference)
    ready.resolve(); await release.promise
    return result
  } } })
  const finishing = gated.finishUpload(f.alice.token, upload.uploadId).then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([ready.promise,finishing.then(() => { throw new Error('Finisher ended before barrier') })])
    await f.admin.query('SELECT pg_sleep(0.6)')
    release.resolve()
    assert.equal((await finishing).error?.statusCode,410)
    assert.equal((await f.files.listFiles(f.alice.token)).files.length,0)
    const usage = await f.files.usage(f.alice.token)
    assert.equal(usage.reservedBytes,0); assert.equal(usage.storedBytes,bytes.length)
  } finally { release.resolve(); await finishing }
})

test('client disconnect retains transfer admission until real publication work settles', { timeout: 20_000 }, async t => {
  const ready = deferred(), thirdEntered = deferred(), release = deferred()
  let entered = 0
  const f = await fileFixture(t, { wrapObjects: base => ({ ...base, async putImmutable(key, bytes) {
    const reference = await base.putImmutable(key,bytes)
    entered++
    if (entered === 2) ready.resolve()
    if (entered === 3) thirdEntered.resolve()
    await release.promise
    return reference
  } }) })
  const bytes = await docxBytes(), headers = signedHeaders(f)
  const uploads = []
  for (let i = 0; i < 3; i++) uploads.push(await f.files.stageUpload(f.alice.token,{ name: 'bounded.docx', size: bytes.length }))
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' })
  const { request } = await import('node:http')
  const start = upload => {
    const req = request(address + '/api/v1/uploads/' + upload.uploadId + '/content', { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': bytes.length } })
    const closed = new Promise(resolve => req.once('close',resolve))
    const finished = new Promise(resolve => { req.once('error',error => resolve({ error })); req.once('response',res => { res.resume(); res.once('end',()=>resolve({ status: res.statusCode })) }) })
    req.end(bytes)
    return { req, closed, finished }
  }
  const serverClosed = deferred()
  f.app.server.on('request', (request, response) => { if (request.url.includes(uploads[0].uploadId)) response.once('close',serverClosed.resolve) })
  const a = start(uploads[0]), b = start(uploads[1])
  let third
  try {
    await Promise.race([ready.promise,Promise.all([a.finished,b.finished]).then(() => { throw new Error('Publication barrier not entered') })])
    a.req.destroy(); await a.closed; await serverClosed.promise
    third = f.app.inject({ method: 'PUT', url: '/api/v1/uploads/' + uploads[2].uploadId + '/content', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
    const observed = await Promise.race([third.then(reply => ({ status: reply.statusCode })),thirdEntered.promise.then(() => ({ status: 'admitted while prior work live' }))])
    assert.equal(observed.status,503)
    assert.equal(entered,2)
  } finally {
    release.resolve()
    await Promise.allSettled([a.finished,b.finished,third].filter(Boolean))
    a.req.destroy(); b.req.destroy()
  }
  const retry = await f.app.inject({ method: 'PUT', url: '/api/v1/uploads/' + uploads[2].uploadId + '/content', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
  assert.equal(retry.statusCode,200)
})

test('a staged upload and a user download wait for concurrent document reads', { timeout: 30_000 }, async t => {
  const reading = deferred(), release = deferred(), attempted = deferred(), attemptedDownload = deferred()
  let phase='fixture'
  t.after(()=>{
    release.resolve()
    if(phase!=='done')t.diagnostic('Transfer barrier phase: '+phase)
  })
  let reads = 0
  const f = await fileFixture(t, { wrapObjects: base => ({ ...base, async readVerified(...args) {
    if (++reads === 2) reading.resolve()
    await release.promise
    return base.readVerified(...args)
  } }) })
  const bytes = await docxBytes(), headers = signedHeaders(f)
  const {file} = await importFile(f,f.bob.token,bytes,'source.docx')
  // The two paused reads hold their credential in the business transaction.
  // Use a second signed session so the test reaches the shared transfer queue.
  const downloader = await f.sessions.login('bob',password)
  const upload = await f.files.stageUpload(f.alice.token,{name:'report.docx',size:bytes.length})
  const url = `/api/v1/uploads/${upload.uploadId}`
  const admission = objectTransferAdmission(f.app), admit = admission.admit
  t.mock.method(admission,'admit',(request,...args)=>{
    try{return admit(request,...args)}
    finally{
      if(request.method==='PUT')attempted.resolve()
      if(request.method==='GET'&&request.query?.download==='1')attemptedDownload.resolve()
    }
  })
  const downloads = [1,2].map(()=>f.app.inject({method:'GET',url:`/api/v1/files/${file.fileId}/content?revision=${file.revision}`,headers:signedHeaders(f,f.bob.token)}).then(response=>response))
  let receiving,interactive
  try {
    phase='source reads'
    await Promise.race([reading.promise,...downloads.map(result=>result.then(response=>assert.fail(`Read finished before barrier: ${response.statusCode}`)))])
    phase='upload admission'
    receiving = f.app.inject({method:'PUT',url:url+'/content',headers:{...headers,'content-type':'application/octet-stream'},payload:bytes}).then(response=>response)
    await Promise.race([attempted.promise,receiving.then(response=>assert.fail(`Upload missed admission: ${response.statusCode}`))])
    const downloadUrl=`/api/v1/files/${file.fileId}/content?revision=${file.revision}&download=1`
    phase='download admission'
    interactive=f.app.inject({method:'GET',url:downloadUrl,headers:signedHeaders(f,downloader.token)}).then(response=>response)
    await Promise.race([attemptedDownload.promise,interactive.then(response=>assert.fail(`Download missed admission: ${response.statusCode}`))])
    release.resolve()
    phase='published bytes'
    assert.equal((await receiving).statusCode,200)
    const downloaded=await interactive
    assert.equal(downloaded.statusCode,200)
    assert.deepEqual(downloaded.rawPayload,bytes)
    assert.equal((await f.app.inject({method:'GET',url:downloadUrl,headers})).statusCode,404)
    assert.equal((await f.app.inject({method:'GET',url:downloadUrl.replace('download=1','download=anything'),headers:signedHeaders(f,f.bob.token)})).statusCode,400)
    const finished = await f.app.inject({method:'POST',url:url+'/finish',headers})
    assert.equal(finished.statusCode,200)
    const saved = finished.json().file
    assert.equal(saved.fileId,upload.fileId)
    assert.deepEqual(await f.files.readFile(f.alice.token,saved.fileId,saved.revision),bytes)
    assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
  } finally {
    release.resolve()
    await Promise.allSettled([...downloads,...(receiving?[receiving]:[]),...(interactive?[interactive]:[])])
  }
  assert.deepEqual((await Promise.all(downloads)).map(response=>response.statusCode),[200,200])
  phase='done'
})

test('duplicate receives have one winner and concurrent finish retries return one initial revision', async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const upload = await f.files.stageUpload(f.alice.token,{ name: 'once.docx', size: bytes.length })
  const received = await Promise.allSettled([f.files.receiveUpload(f.alice.token,upload.uploadId,bytes),f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)])
  assert.equal(received.filter(result => result.status === 'fulfilled').length,1)
  assert.equal(received.find(result => result.status === 'rejected').reason.statusCode,409)
  const finished = await Promise.all([f.files.finishUpload(f.alice.token,upload.uploadId),f.files.finishUpload(f.alice.token,upload.uploadId)])
  assert.deepEqual(finished[0],finished[1])
  assert.equal((await f.files.listFiles(f.alice.token)).files.length,1)
  assert.equal((await f.files.usage(f.alice.token)).storedBytes,bytes.length)
  assert.equal((await readdir(f.directory)).length,1)
  await assert.rejects(() => own(f,connection => connection.query("UPDATE file_revisions SET sha256=repeat('0',64)")), { code: '42501' })
  await assert.rejects(() => own(f,connection => connection.query('DELETE FROM files')), { code: '42501' })
})

test('a finishing import holds authority through commit before account disable may complete', { timeout: 15_000 }, async t => {
  const f = await fileFixture(t), bytes = await docxBytes()
  const { createFileService } = await import('../../server/src/modules/files/service.ts')
  const { waitForDatabaseLock } = await import('../helpers/restricted.mjs')
  const upload = await f.files.stageUpload(f.alice.token,{ name: 'commits-first.docx', size: bytes.length })
  await f.files.receiveUpload(f.alice.token,upload.uploadId,bytes)
  const ready = deferred(), release = deferred()
  const gated = createFileService({ transactions: f.transactions, objects: { ...f.objects, async verifyObject(reference) {
    const result = await f.objects.verifyObject(reference)
    ready.resolve(); await release.promise
    return result
  } } })
  const finishing = gated.finishUpload(f.alice.token,upload.uploadId)
  let disable
  try {
    await Promise.race([ready.promise,finishing.then(() => { throw new Error('Finisher ended before barrier') })])
    disable = f.users.update(f.adminSigned.token,f.alice.user.id,{ status: 'disabled' })
    await waitForDatabaseLock(f,'auth')
    release.resolve()
    const opened = await finishing
    await disable
    await assert.rejects(() => f.files.openFile(f.alice.token,opened.file.fileId), { statusCode: 401 })
    await f.users.update(f.adminSigned.token,f.alice.user.id,{ status: 'active' })
    const { password } = await import('../helpers/identity.mjs'), fresh = await f.sessions.login('alice',password)
    assert.deepEqual(await f.files.readFile(fresh.token,opened.file.fileId,opened.file.revision),bytes)
  } finally { release.resolve(); await Promise.allSettled([finishing,disable].filter(Boolean)) }
})

test('editor assets use a bounded quota separate from document entry and file APIs',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'office-assets-quota-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 await mkdir(join(directory,'.vite'))
 await mkdir(join(directory,'assets'))
 await writeFile(join(directory,'index.html'),'<title>PDF editor</title>')
 await writeFile(join(directory,'assets/editor.js'),'void 0')
 await writeFile(join(directory,'.vite/manifest.json'),'{"entry":{"file":"assets/editor.js"}}')
 await writeFile(join(directory,'.vite/native-assets.json'),'[]')
 const f=await fileFixture(t,{buildApp:false})
 const {buildLocalApp}=await import('../../server/src/app.ts')
 const app=await buildLocalApp({
  db:f.db,businessPool:f.businessPool,passwords:f.passwords,deploymentId:f.deploymentId,
  origin:restrictedOrigin,csrfKey:f.csrfKey,objectStore:f.objects,
  nativePdfDirectory:directory,localShellDirectory:directory,rateLimit:{max:2,windowMs:60000},
 })
 f.cleanup.unshift(()=>app.close())
 const pdf=await PDFDocument.create()
 pdf.addPage([240,300])
 const {file}=await importFile(f,f.alice.token,Buffer.from(await pdf.save()),'quota.pdf')
 const headers=signedHeaders(f)
 const pdfAsset='/native-pdf/assets/editor.js', shellAsset='/assets/editor.js'
 assert.equal((await app.inject({url:pdfAsset,remoteAddress:'192.0.2.5'})).statusCode,401)
 assert.equal((await app.inject({url:'/native-pdf/assets/private.js',headers,remoteAddress:'192.0.2.6'})).statusCode,404)
 const entry='/native-pdf/?fileId='+file.fileId, metadata='/api/v1/files/'+file.fileId
 const request=(url,method='GET')=>app.inject({url,method,headers})
 for(const url of [pdfAsset,shellAsset,pdfAsset]){
  const result=await request(url)
  assert.equal(result.statusCode,200,url)
  assert.equal(result.headers['cache-control'],'private, no-store')
 }
 assert.equal((await request(entry)).statusCode,200)
 assert.equal((await request(metadata)).statusCode,200)
 assert.equal((await request('/native-pdf/index.html?fileId='+file.fileId)).statusCode,429)
 assert.equal((await request('/native-pdf/assets/../index.html?fileId='+file.fileId)).statusCode,429)
 for(let i=0;i<5;i++) assert.equal((await request(i%2?pdfAsset:shellAsset,'HEAD')).statusCode,200)
 assert.equal((await request(pdfAsset)).statusCode,429)
})

test('a zero-byte CSV survives upload, download, duplicate and version restore without adding bytes', async t => {
  const f=await fileFixture(t),token=f.alice.token,empty=Buffer.alloc(0)
  const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
  const headers={cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token)}
  const upload=await f.app.inject({method:'POST',url:'/api/v1/files/uploads',headers,payload:{name:'Blank.CSV',size:0}})
  assert.equal(upload.statusCode,201,upload.body)
  const {uploadId,fileId}=upload.json(),base='/api/v1/uploads/'+uploadId
  const ready=await f.app.inject({method:'PUT',url:base+'/content',headers:{...headers,'content-type':'application/octet-stream'},payload:empty})
  assert.equal(ready.statusCode,200,ready.body)
  const finished=await f.app.inject({method:'POST',url:base+'/finish',headers})
  assert.equal(finished.statusCode,200,finished.body)
  const {file,format,name,downloadEndpoint}=finished.json()
  assert.equal(file.size,0)
  assert.equal(file.sha256,createHash('sha256').update(empty).digest('hex'))
  assert.equal(format,'csv')
  assert.equal(name,'Blank.CSV')
  const original=await f.app.inject({method:'GET',url:downloadEndpoint,headers})
  assert.equal(original.statusCode,200,original.body)
  assert.equal(original.headers['content-length'],'0')
  assert.deepEqual(original.rawPayload,empty)
  await assert.rejects(f.files.stageUpload(token,{name:'Blank.xlsx',size:0}),{statusCode:400})
  const duplicate=await f.files.prepareDuplicate(token,fileId)
  const copy=await f.files.finishDuplicate(token,fileId,duplicate.uploadId,duplicate.revision,'en')
  assert.equal(copy.file.size,0)
  assert.deepEqual(await f.files.readFile(token,copy.file.fileId,copy.file.revision),empty)

  const {createLeaseService}=await import('../../server/src/modules/leases/service.ts')
  const {createRevisionService}=await import('../../server/src/modules/revisions/service.ts')
  const leases=createLeaseService({transactions:f.transactions})
  const revisions=createRevisionService({transactions:f.transactions,objects:f.objects,files:f.files})
  const editorId=randomUUID(),{leaseEpoch}=await leases.acquireLease(token,fileId,{editorId})
  const text=Buffer.from('filled\r\n')
  const draft=await revisions.stageUpload(token,fileId,{size:text.length,baseRevision:file.revision,leaseEpoch,editorId})
  await f.files.receiveUpload(token,draft.uploadId,text)
  const commit=async(uploadId,baseRevision)=>revisions.commitRevision(token,{fileId,uploadId,baseRevision,leaseEpoch,idempotencyKey:randomUUID()})
  const saved=await commit(draft.uploadId,file.revision)
  const undo=await revisions.stageRestore(token,fileId,{revision:file.revision,baseRevision:saved.revision,leaseEpoch,editorId})
  const restored=await commit(undo.uploadId,saved.revision)
  assert.equal(restored.size,0)
  assert.deepEqual(await f.files.readFile(token,fileId,restored.revision),empty)
  assert.deepEqual(await f.files.readFile(token,fileId,saved.revision),text)
})

test('generated CSV writes BOM-prefixed worksheet values with a unique workspace name', async t => {
  const f=await fileFixture(t,{buildApp:false}),token=f.alice.token
  const {createApiShell}=await import('../../server/src/framework.ts')
  const {registerFileRoutes}=await import('../../server/src/modules/files/routes.ts')
  const app=await createApiShell();t.after(()=>app.close())
  const csrf=createCsrfService({db:f.db,deploymentId:f.deploymentId,origin:restrictedOrigin,key:f.csrfKey})
  registerFileRoutes(app,f.files,f.sessions,csrf,undefined,{},true)
  const existing=await importFile(f,token,Buffer.from('existing'),'地区_收入.CSV')
  const headers={cookie:'__Host-dyoffice-session='+token,origin:restrictedOrigin,'x-csrf-token':csrf.sessionToken(token),'content-type':'application/octet-stream'}
  const url='/api/v1/ai/csv-documents?'+new URLSearchParams({title:'地区/收入'})
  const payload=Buffer.from('地区,数值\r\n华东,007\r\n')
  const create=options=>app.inject({method:'POST',url,headers,payload,...options})
  assert.equal((await create({headers:{...headers,'x-csrf-token':'invalid'}})).statusCode,403)
  assert.equal((await create({payload:Buffer.from([0xff])})).statusCode,400)
  const created=await Promise.all([create(),create()])
  assert.ok(created.every(response=>response.statusCode===200),created.map(response=>response.body).join('\n'))
  const files=created.map(response=>response.json())
  assert.deepEqual(files.map(file=>file.name).sort(),['地区_收入-2.csv','地区_收入-3.csv'])
  assert.notEqual(files[0].file.fileId,files[1].file.fileId)
  for(const result of files){
    assert.equal(result.format,'csv')
    assert.deepEqual(await f.files.readFile(token,result.file.fileId,result.file.revision),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),payload]))
    await assert.rejects(f.files.openFile(f.bob.token,result.file.fileId),{statusCode:404})
  }
  assert.deepEqual(await f.files.readFile(token,existing.file.fileId,existing.file.revision),Buffer.from('existing'))
})
