import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { randomBytes } from 'node:crypto'
import { chromium } from '@playwright/test'
import { buildLocalApp } from '../../server/src/app.ts'
import { restrictedFixture } from '../helpers/restricted.mjs'
import { password } from '../helpers/identity.mjs'
import { restrictedIdentityFixture } from '../helpers/restricted-identity.mjs'

async function tlsFixture(t, restricted = false, fileApi = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-auth-tls-'))
  let app, browser, server
  t.after(async () => {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await app?.close()
    await rm(directory, { recursive: true, force: true })
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' })
  server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (req, res) => app.routing(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  const { createLocalObjectStore } = await import('../../server/src/storage/local-dev.ts')
  const objectStore = fileApi ? await createLocalObjectStore({ directory: join(directory, 'objects') }) : undefined
  const f = restricted ? await restrictedFixture(t, { origin, objectStore }) : await restrictedIdentityFixture(t)
  app = restricted ? f.app : await buildLocalApp({ db: f.db, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: randomBytes(32).toString('hex') })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await page.goto(origin + '/')
  return { ...f, app, browser, context, page, origin }
}

test('real Chromium retains Secure HttpOnly host cookies over TLS and logout removes server access', { timeout: 30_000 }, async t => {
  const { user, context, page } = await tlsFixture(t)
  const loggedIn = await page.evaluate(async password => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken }, body: JSON.stringify({ username: 'owner', password }) })
    return { status: response.status, body: await response.json(), visibleCookies: document.cookie }
  }, password)
  assert.equal(loggedIn.status, 200)
  assert.equal(loggedIn.body.user.id, user.id)
  assert.equal(loggedIn.visibleCookies.includes('__Host-dyoffice'), false)
  const stored = await context.cookies()
  assert.equal(stored.length, 1)
  assert.equal(stored[0].name, '__Host-dyoffice-session')
  assert.equal(stored[0].secure, true)
  assert.equal(stored[0].httpOnly, true)
  assert.equal(stored[0].sameSite, 'Lax')
  assert.equal(stored[0].path, '/')
  assert.equal(JSON.stringify(loggedIn.body).includes(stored[0].value), false)
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/auth/me')).status), 200)
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/auth/logout', { method: 'POST' })).status), 403)
  const result = await page.evaluate(async csrf => {
    const logout = await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } })
    const me = await fetch('/api/v1/auth/me')
    return { logout: logout.status, me: me.status }
  }, loggedIn.body.csrfToken)
  assert.deepEqual(result, { logout: 204, me: 401 })
  assert.deepEqual(await context.cookies(), [])
})

test('Chromium admin/API lifecycle activates an account, rotates its password and invalidates it on reset', { timeout: 30_000 }, async t => {
  const { browser, page, origin } = await tlsFixture(t)
  const admin = await page.evaluate(async password => {
    const c = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': c.csrfToken }, body: JSON.stringify({ username: 'owner', password }) })).json()
  }, password)
  const created = await page.evaluate(async csrf => {
    const response = await fetch('/api/v1/admin/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ username: 'browser-user' }) })
    return { status: response.status, body: await response.json() }
  }, admin.csrfToken)
  assert.equal(created.status, 201)
  const personalContext = await browser.newContext({ ignoreHTTPSErrors: true })
  const personal = await personalContext.newPage()
  await personal.goto(origin + '/')
  const activated = await personal.evaluate(async ({ action, password }) => {
    const c = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/password-action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': c.csrfToken }, body: JSON.stringify({ token: action.token, purpose: action.purpose, password }) })).status
  }, { action: created.body.action, password })
  assert.equal(activated, 204)
  assert.deepEqual(await personalContext.cookies(), [])
  const signed = await personal.evaluate(async password => {
    const c = await (await fetch('/api/v1/auth/csrf')).json()
    const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': c.csrfToken }, body: JSON.stringify({ username: 'browser-user', password }) })
    return { status: response.status, body: await response.json() }
  }, password)
  assert.equal(signed.status, 200)
  assert.equal(await personal.evaluate(async () => (await fetch('/api/v1/admin/users')).status), 403)
  const before = (await personalContext.cookies())[0].value
  const nextPassword = 'browser lanterns over distant silver rivers 8642'
  const changed = await personal.evaluate(async ({ currentPassword, newPassword, csrf }) => {
    const response = await fetch('/api/v1/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ currentPassword, newPassword }) })
    return { status: response.status, body: await response.json() }
  }, { currentPassword: password, newPassword: nextPassword, csrf: signed.body.csrfToken })
  assert.equal(changed.status, 200)
  assert.notEqual((await personalContext.cookies())[0].value, before)
  assert.equal(await personal.evaluate(async () => (await fetch('/api/v1/auth/me')).status), 200)
  const reset = await page.evaluate(async ({ id, csrf }) => {
    const response = await fetch('/api/v1/admin/users/' + id + '/password-reset', { method: 'POST', headers: { 'x-csrf-token': csrf } })
    return { status: response.status, body: await response.json() }
  }, { id: created.body.user.id, csrf: admin.csrfToken })
  assert.equal(reset.status, 200)
  assert.equal(await personal.evaluate(async () => (await fetch('/api/v1/auth/me')).status), 401)
  assert.equal(await page.evaluate(async () => (await fetch('/api/v1/auth/me')).status), 200)
  const redeemed = await personal.evaluate(async ({ action, password }) => {
    const c = await (await fetch('/api/v1/auth/csrf')).json()
    return (await fetch('/api/v1/auth/password-action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': c.csrfToken }, body: JSON.stringify({ token: action.token, purpose: action.purpose, password }) })).status
  }, { action: reset.body.action, password: 'reset lanterns drift over distant silver rivers 3579' })
  assert.equal(redeemed, 204)
})


test('Chromium TLS sessions keep Alice and Bob preferences isolated with restricted database roles', { timeout: 30_000 }, async t => {
  const { browser, page, origin, bob } = await tlsFixture(t, true)
  const other = await browser.newContext({ ignoreHTTPSErrors: true })
  const bobPage = await other.newPage()
  await bobPage.goto(origin + '/')
  const login = (page, username) => page.evaluate(async ({ username, password }) => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken }, body: JSON.stringify({ username, password }) })
    return { status: response.status, body: await response.json() }
  }, { username, password })
  const a = await login(page, 'alice'), b = await login(bobPage, 'bob')
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  const update = (page, csrf, body) => page.evaluate(async ({ csrf, body }) => (await fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) })).status, { csrf, body })
  assert.equal(await update(page, a.body.csrfToken, { authorName: 'Alice' }), 200)
  assert.equal(await update(bobPage, b.body.csrfToken, { authorName: 'Bob' }), 200)
  assert.equal(await update(page, a.body.csrfToken, { ownerId: bob.user.id, authorName: 'forged' }), 400)
  assert.equal(await page.evaluate(async () => (await (await fetch('/api/v1/preferences')).json()).authorName), 'Alice')
  assert.equal(await bobPage.evaluate(async () => (await (await fetch('/api/preferences')).json()).authorName), 'Bob')
})


test('Chromium TLS file lifecycle uses scoped cookies for import, download, recycle and restore', { timeout: 30_000 }, async t => {
  const { page, browser, origin } = await tlsFixture(t, true, true)
  const bytes = await readFile(new URL('../../../../packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx', import.meta.url))
  const login = (page, username) => page.evaluate(async ({ username, password }) => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken }, body: JSON.stringify({ username, password }) })
    return { status: response.status, body: await response.json() }
  }, { username, password })
  const signed = await login(page,'alice')
  assert.equal(signed.status,200)
  const imported = await page.evaluate(async ({ csrf, bytes }) => {
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf }
    const stage = await fetch('/api/v1/files/uploads', { method: 'POST', headers, body: JSON.stringify({ name: 'browser.docx', size: bytes.length }) })
    const upload = await stage.json()
    const receive = await fetch('/api/v1/uploads/' + upload.uploadId + '/content', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrf }, body: new Uint8Array(bytes) })
    const finish = await fetch('/api/v1/uploads/' + upload.uploadId + '/finish', { method: 'POST', headers: { 'x-csrf-token': csrf } })
    return { stage: stage.status, receive: receive.status, finish: finish.status, opened: await finish.json() }
  }, { csrf: signed.body.csrfToken, bytes: [...bytes] })
  assert.equal(imported.stage,201); assert.equal(imported.receive,200); assert.equal(imported.finish,200)
  const downloaded = await page.evaluate(async endpoint => Array.from(new Uint8Array(await (await fetch(endpoint)).arrayBuffer())), imported.opened.downloadEndpoint)
  assert.deepEqual(Buffer.from(downloaded),bytes)
  const other = await browser.newContext({ ignoreHTTPSErrors: true }), bob = await other.newPage()
  await bob.goto(origin + '/')
  assert.equal((await login(bob,'bob')).status,200)
  assert.equal(await bob.evaluate(async endpoint => (await fetch(endpoint)).status, imported.opened.downloadEndpoint),404)
  const lifecycle = await page.evaluate(async ({ id, endpoint, csrf }) => {
    const headers = { 'x-csrf-token': csrf }
    const trash = await fetch('/api/v1/files/' + id, { method: 'DELETE', headers })
    const denied = await fetch(endpoint)
    const restore = await fetch('/api/v1/files/' + id + '/restore', { method: 'POST', headers })
    const reopened = await fetch(endpoint)
    return [trash.status,denied.status,restore.status,reopened.status]
  }, { id: imported.opened.file.fileId, endpoint: imported.opened.downloadEndpoint, csrf: signed.body.csrfToken })
  assert.deepEqual(lifecycle,[204,404,204,200])
})

test('Chromium TLS saves, retries, fences a stale editor and restores history as a new revision', { timeout: 30_000 }, async t => {
  const { page } = await tlsFixture(t,true,true)
  const original = await readFile(new URL('../../../../packages/docx-engine/tests/fixtures/truths/render-sectafter-no-blank/probe.docx', import.meta.url))
  const { default: JSZip } = await import('jszip'), zip = await JSZip.loadAsync(original)
  zip.file('word/document.xml',(await zip.file('word/document.xml').async('string')).replace('</w:body>','<w:p><w:r><w:t>Browser committed text</w:t></w:r></w:p></w:body>'))
  const changed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const result = await page.evaluate(async ({ password, original, changed }) => {
    const challenge = await (await fetch('/api/v1/auth/csrf')).json()
    const signed = await (await fetch('/api/v1/auth/login',{ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken }, body: JSON.stringify({ username: 'alice', password }) })).json()
    const json = async (method, url, body) => {
      const reply = await fetch(url,{ method, headers: body === undefined ? { 'x-csrf-token': signed.csrfToken } : { 'content-type': 'application/json', 'x-csrf-token': signed.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: reply.status, body: await reply.json() }
    }
    const put = async (uploadId, bytes) => (await fetch('/api/v1/uploads/' + uploadId + '/content',{ method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': signed.csrfToken }, body: new Uint8Array(bytes) })).status
    const imported = await json('POST','/api/v1/files/uploads',{ name: 'save-browser.docx', size: original.length })
    const initialReceive = await put(imported.body.uploadId,original)
    const opened = await json('POST','/api/v1/uploads/' + imported.body.uploadId + '/finish')
    const fileId = opened.body.file.fileId, base = '/api/v1/files/' + fileId, editorId = crypto.randomUUID()
    const lease = await json('POST',base + '/lease',{ editorId })
    const staged = await json('POST',base + '/uploads',{ size: changed.length, baseRevision: opened.body.file.revision, leaseEpoch: lease.body.leaseEpoch, editorId })
    const receive = await put(staged.body.uploadId,changed)
    const input = { fileId, uploadId: staged.body.uploadId, baseRevision: opened.body.file.revision, leaseEpoch: lease.body.leaseEpoch, idempotencyKey: crypto.randomUUID() }
    const committed = await json('POST',base + '/commits',input)
    const retried = await json('POST',base + '/commits',input)
    const nextEditor = crypto.randomUUID(), taken = await json('POST',base + '/lease/takeover',{ editorId: nextEditor, expectedEpoch: lease.body.leaseEpoch })
    const stale = await json('POST',base + '/uploads',{ size: changed.length, baseRevision: committed.body.revision, leaseEpoch: lease.body.leaseEpoch, editorId })
    const download = Array.from(new Uint8Array(await (await fetch(base + '/content?revision=' + committed.body.revision)).arrayBuffer()))
    const restoration = await json('POST',base + '/restoration-uploads',{ revision: opened.body.file.revision, baseRevision: committed.body.revision, leaseEpoch: taken.body.leaseEpoch, editorId: nextEditor })
    const restored = await json('POST',base + '/commits',{ fileId, uploadId: restoration.body.uploadId, baseRevision: committed.body.revision, leaseEpoch: taken.body.leaseEpoch, idempotencyKey: crypto.randomUUID() })
    const restoredBytes = Array.from(new Uint8Array(await (await fetch(base + '/content?revision=' + restored.body.revision)).arrayBuffer()))
    const history = await (await fetch(base + '/revisions')).json()
    return { statuses: [imported.status,initialReceive,opened.status,lease.status,staged.status,receive,committed.status,retried.status,taken.status,stale.status,restoration.status,restored.status], initial: opened.body.file, saved: committed.body, retried: retried.body, restored: restored.body, download, restoredBytes, history }
  },{ password, original: [...original], changed: [...changed] })
  assert.deepEqual(result.statuses,[201,200,200,200,201,200,200,200,200,409,201,200])
  assert.deepEqual(result.retried,result.saved)
  assert.notEqual(result.restored.revision,result.initial.revision)
  assert.notEqual(result.restored.revision,result.saved.revision)
  assert.deepEqual(Buffer.from(result.download),changed)
  assert.deepEqual(Buffer.from(result.restoredBytes),original)
  assert.equal(result.history.revisions.length,3)
})
