import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from './helpers/prototype-app.mjs'
import { AccountLifecycleError } from '../server/auth/account-lifecycle.mjs'

const deploymentId = randomUUID()
const userId = randomUUID()
const sessionId = randomUUID()
const origin = 'http://127.0.0.1:3080'

function shell() {
  const principal = { deploymentId, userId, sessionId, roles: ['config_admin', 'user'], authVersion: '2', expiresAt: '2030-01-01T00:00:00.000Z' }
  const state = { logins: 0, listed: false }
  const localAuth = {
    deploymentId,
    trustedOrigin: origin,
    loginService: { async login() { state.logins += 1; return { ok: true, cookie: '__Host-dyoffice_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax' } } },
    sessionService: {
      async authenticate() { return principal },
      async revoke() { return true },
    },
    csrfPolicy: { verify: () => true, issue: () => 'csrf-token-value' },
    accounts: {
      async listUsers() {
        state.listed = true
        return { users: [{ userId, username: 'ada.local', displayName: 'Ada', status: 'active', roles: ['user'] }], nextCursor: null }
      },
      async createAccount() { throw new AccountLifecycleError('FORBIDDEN') },
    },
    passwordChange: { async changePassword() { return { cookie: '__Host-dyoffice_session=next; Path=/; HttpOnly; Secure; SameSite=Lax' } } },
    sessions: { async list() { return { sessions: [], nextCursor: null } }, async revoke() { return { currentRevoked: false } }, async revokeOthers() { return { currentRevoked: false } } },
    reauth: { async reauthenticate() { return { ok: true, userId, reauthenticatedAt: '2030-01-01T00:00:00.000Z' } } },
  }
  return { state, config: { env: 'test', rateLimit: { max: 100, windowMs: 60_000 }, readyCheck: async () => true, localAuth } }
}

test('local auth routes establish a principal and keep admin file data out of the user list', async () => {
  const { state, config } = shell()
  const app = await buildApp(config)
  const missing = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ada.local', password: 'correct horse battery' } })
  assert.equal(missing.statusCode, 403)
  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { username: 'ada.local', password: 'correct horse battery' },
  })
  assert.equal(login.statusCode, 200)
  assert.match(login.headers['set-cookie'], /__Host-dyoffice_session=/)
  assert.equal(login.json().ok, true)
  assert.equal(state.logins, 1)
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().userId, userId)
  assert.equal(JSON.stringify(me.json()).includes('password'), false)
  const users = await app.inject({ method: 'GET', url: '/api/v1/admin/users' })
  assert.equal(users.statusCode, 200)
  assert.equal(state.listed, true)
  assert.equal(JSON.stringify(users.json()).includes('password'), false)
  assert.equal(JSON.stringify(users.json()).includes('fileId'), false)
  const blocked = await app.inject({
    method: 'POST', url: '/api/v1/admin/users', headers: { origin },
    payload: { username: 'new.user', displayName: 'New', adminPassword: 'x', role: 'config_admin' },
  })
  assert.equal(blocked.statusCode, 400)
  await app.close()
})

test('legacy raw-body mode still accepts JSON on local auth routes', async () => {
  const { state, config } = shell()
  const app = await buildApp({
    ...config,
    legacy: {
      serveStatic() {},
      store: { read() { return { files: [], preferences: {}, admin: {} } } },
      credentials: { userToken: 'personal-token', adminToken: 'admin-token' },
    },
  })
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin, 'content-type': 'application/json' },
    payload: JSON.stringify({ username: 'ada.local', password: 'correct horse battery' }),
  })
  assert.equal(login.statusCode, 200)
  assert.equal(state.logins, 1)
  assert.equal(login.json().ok, true)
  const preferences = await app.inject({
    method: 'GET',
    url: '/api/preferences',
    headers: { authorization: 'Bearer personal-token' },
  })
  assert.equal(preferences.statusCode, 200)
  await app.close()
})

test('auth routes stay unimplemented until local auth is configured', async () => {
  const app = await buildApp({ env: 'test', rateLimit: { max: 20, windowMs: 60_000 }, readyCheck: async () => true })
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'a', password: 'b' } })
  assert.equal(login.statusCode, 501)
  await app.close()
})
