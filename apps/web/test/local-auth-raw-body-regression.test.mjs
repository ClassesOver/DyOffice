import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { buildApp } from './helpers/prototype-app.mjs'

const origin = 'http://127.0.0.1:3080'
const targetId = randomUUID()
const jsonHeaders = { origin, 'content-type': 'application/json' }
const AUTH_LIMIT = 8192

async function fixture(t, legacy) {
  const calls = []
  const mutation = name => async (_request, input) => {
    calls.push({ name, input })
    return { userId: input.userId, ...(name === 'roles' ? { roles: input.roles } : { status: input.enabled ? 'active' : 'disabled' }) }
  }
  const config = {
    env: 'test', rateLimit: { max: 100, windowMs: 60_000 }, readyCheck: async () => true,
    localAuth: {
      deploymentId: randomUUID(), trustedOrigin: origin,
      loginService: { async login(input) { calls.push({ name: 'login', input }); return { ok: false, code: 'INVALID_CREDENTIALS' } } },
      sessionService: { async authenticate() { return null }, async revoke() { return false } },
      csrfPolicy: { verify() { return false }, issue() { return 'unused' } },
      accounts: {
        setAccountEnabled: mutation('enabled'), setRoles: mutation('roles'),
        async redeemPasswordAction(_request, input) { calls.push({ name: 'redeem', input }); return { userId: targetId } },
      },
      passwordChange: {}, sessions: {}, reauth: {},
    },
  }
  if (legacy) config.legacy = {
    serveStatic() {},
    store: { read() { return { files: [], preferences: {}, admin: {} } } },
    credentials: { userToken: 'personal-token', adminToken: 'admin-token' },
  }
  const app = await buildApp(config)
  t.after(() => app.close())
  return { app, calls }
}

for (const legacy of [false, true]) {
  const mode = legacy ? 'legacy raw-body + localAuth' : 'localAuth JSON parser'

  test(`${mode}: administrator PATCH parses enabled and roles JSON`, async t => {
    const { app, calls } = await fixture(t, legacy)
    for (const body of [
      { enabled: false, adminPassword: 'existing administrator password' },
      { enabled: true, adminPassword: 'existing administrator password' },
      { roles: ['user', 'auditor'], adminPassword: 'existing administrator password' },
    ]) {
      const response = await app.inject({ method: 'PATCH', url: '/api/v1/admin/users/' + targetId,
        headers: jsonHeaders, payload: JSON.stringify(body) })
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(calls.at(-1).input, { userId: targetId, ...body })
    }
    assert.deepEqual(calls.map(call => call.name), ['enabled', 'enabled', 'roles'])
  })

  test(`${mode}: malformed, ambiguous and injected PATCH fields never reach account services`, async t => {
    const { app, calls } = await fixture(t, legacy)
    for (const payload of ['{', '[]', 'null', '{}',
      JSON.stringify({ enabled: false }),
      JSON.stringify({ enabled: false, roles: ['user'], adminPassword: 'secret' }),
      JSON.stringify({ enabled: false, ownerId: targetId, adminPassword: 'secret' }),
      JSON.stringify({ roles: ['user'], userId: targetId, adminPassword: 'secret' })]) {
      const response = await app.inject({ method: 'PATCH', url: '/api/v1/admin/users/' + targetId,
        headers: jsonHeaders, payload })
      assert.equal(response.statusCode, 400, response.body)
    }
    assert.equal(calls.length, 0)
  })

  test(`${mode}: auth request limits are enforced by the body reader before service calls`, async t => {
    const { app, calls } = await fixture(t, legacy)
    const payload = JSON.stringify({ username: 'alice.local', password: 'x'.repeat(AUTH_LIMIT) })
    assert.ok(Buffer.byteLength(payload) > AUTH_LIMIT)
    for (const [method, url] of [
      ['POST', '/api/v1/auth/login'],
      ['PATCH', '/api/v1/admin/users/' + targetId],
      ['POST', '/api/v1/auth/password-action'],
    ]) {
      const response = await app.inject({ method, url, headers: jsonHeaders, payload })
      assert.equal(response.statusCode, 413, `${url}: ${response.body}`)
      assert.equal(response.headers['cache-control'], 'no-store')
    }
    assert.equal(calls.length, 0)
  })
}

test('auth-only size limits preserve larger raw Buffer payloads on legacy routes', async t => {
  const { app } = await fixture(t, true)
  app.post('/api/pr27-raw-regression', async request => ({ raw: Buffer.isBuffer(request.body), size: request.body.byteLength }))
  const bytes = Buffer.alloc(AUTH_LIMIT + 100, 65)
  const response = await app.inject({ method: 'POST', url: '/api/pr27-raw-regression',
    headers: { authorization: 'Bearer personal-token', 'content-type': 'application/octet-stream' }, payload: bytes })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { raw: true, size: bytes.byteLength })
})
