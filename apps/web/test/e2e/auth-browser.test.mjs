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
import { identityFixture, password } from '../helpers/identity.mjs'

async function tlsFixture(t) {
  const f = await identityFixture(t)
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-auth-tls-'))
  let app, browser, server
  f.cleanup.push(async () => {
    await browser?.close()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await app?.close()
    await rm(directory, { recursive: true, force: true })
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'pipe' })
  server = createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (req, res) => app.routing(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  app = await buildLocalApp({ db: f.db, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: randomBytes(32).toString('hex') })
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
