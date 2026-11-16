import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'

async function fixture(t, customize) {
  const f = await fileFixture(t), original = await docxBytes(), opened = await importFile(f,f.alice.token,original,'browser-host.docx')
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' })
  const fetchImpl = (path, init = {}) => fetch(address + path,{ ...init,headers: { ...Object.fromEntries(new Headers(init.headers)), origin: 'https://office.example', cookie: '__Host-dyoffice-session=' + f.alice.token } })
  const { createSessionFileHost } = await import('../../../../packages/browser-host/src/files.ts')
  const host = createSessionFileHost({ fetchImpl: customize ? customize(fetchImpl) : fetchImpl, editorId: randomUUID() })
  t.after(() => host.dispose())
  await host.open(opened.file.fileId); await host.acquireLease(opened.file.fileId)
  return { ...f, host, fetchImpl, original, fileId: opened.file.fileId, initial: opened.file }
}
async function changed(bytes, text) {
  const zip = await JSZip.loadAsync(bytes)
  zip.file('word/document.xml',(await zip.file('word/document.xml').async('string')).replace('</w:body>',`<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>`))
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}
test('session BrowserHost verifies UUID revisions and commits new bytes using its captured lease/base', async t => {
  const f = await fixture(t), bytes = await changed(f.original,'actual host save')
  assert.deepEqual(Buffer.from(await f.host.readBytes(f.fileId,f.initial.revision)),f.original)
  const saved = await f.host.save(f.fileId,bytes)
  assert.notEqual(saved.revision,f.initial.revision)
  assert.deepEqual(Buffer.from(await f.host.readBytes(f.fileId,saved.revision)),Buffer.from(bytes))
  assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,saved.revision)
  const { createSessionFileHost } = await import('../../../../packages/browser-host/src/files.ts')
  const reader = createSessionFileHost({ fetchImpl: f.fetchImpl })
  t.after(() => reader.dispose())
  assert.deepEqual(Buffer.from(await reader.readBytes(f.fileId,f.initial.revision)),f.original)
})
test('lost commit response is reconciled with the same request before another write can start', async t => {
  let drop = true, commits = []
  const f = await fixture(t, real => async (path, init) => {
    const reply = await real(path,init)
    if (path.endsWith('/commits')) {
      commits.push(JSON.parse(init.body))
      if (drop) { drop = false; await reply.arrayBuffer(); throw new TypeError('controlled lost response') }
    }
    return reply
  })
  const bytes = await changed(f.original,'lost receipt')
  await assert.rejects(() => f.host.save(f.fileId,bytes), { code: 'UNAVAILABLE' })
  assert.equal(f.host.getState(f.fileId).status,'unknown')
  const recovered = await f.host.reconcile(f.fileId)
  assert.deepEqual(commits[1],commits[0])
  assert.equal((await f.files.openFile(f.alice.token,f.fileId)).file.revision,recovered.revision)
  assert.equal((await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token },connection => connection.query('SELECT * FROM revision_commits'))).rowCount,1)
})
test('a second editor must take over and the old BrowserHost preserves its conflicted base', async t => {
  const f = await fixture(t), { createSessionFileHost } = await import('../../../../packages/browser-host/src/files.ts')
  const second = createSessionFileHost({ fetchImpl: f.fetchImpl, editorId: randomUUID() })
  t.after(() => second.dispose())
  await second.open(f.fileId)
  await assert.rejects(() => second.acquireLease(f.fileId), { code: 'CONFLICT' })
  await second.takeoverLease(f.fileId)
  const bytes = await changed(f.original,'stale writer')
  await assert.rejects(() => f.host.save(f.fileId,bytes), { code: 'CONFLICT' })
  assert.equal(f.host.getState(f.fileId).revision.revision,f.initial.revision)
})
test('late failed renewal cannot erase a newer explicit takeover', async t => {
  let release, reached
  const waiting = new Promise(resolve => { reached = resolve })
  const f = await fixture(t,real => async (path,init) => {
    if (path.endsWith('/renew')) {
      reached(); await new Promise(resolve => { release = resolve })
      return new Response('{}',{ status: 409,headers: { 'content-type': 'application/json' } })
    }
    return real(path,init)
  })
  const oldRenew = f.host.renewLease(f.fileId)
  const rejected = assert.rejects(oldRenew,{ code: 'CONFLICT' })
  await waiting
  const newer = await f.host.takeoverLease(f.fileId)
  release(); await rejected
  assert.equal(f.host.getState(f.fileId).lease?.leaseEpoch,newer.leaseEpoch)
})
test('renewal preserves unknown commit outcome until its exact receipt is confirmed', async t => {
  const f = await fixture(t,real => async (path,init) => {
    const reply = await real(path,init)
    if (path.endsWith('/commits')) { await reply.arrayBuffer(); throw new TypeError('lost response') }
    return reply
  })
  await assert.rejects(() => f.host.save(f.fileId,new Uint8Array(f.original)))
  await f.host.renewLease(f.fileId)
  assert.equal(f.host.getState(f.fileId).status,'unknown')
})
test('page exit starts its keepalive lease release before disposing browser state', async t => {
  const f = await fixture(t)
  const releasing = f.host.releaseLease(f.fileId,true)
  f.host.dispose()
  await releasing
  const { createSessionFileHost } = await import('../../../../packages/browser-host/src/files.ts')
  const reopened = createSessionFileHost({ fetchImpl: f.fetchImpl })
  t.after(() => reopened.dispose())
  await reopened.open(f.fileId)
  assert.ok((await reopened.acquireLease(f.fileId)).leaseEpoch > 1)
})
