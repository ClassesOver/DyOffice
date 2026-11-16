import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createPasswordChangeHttpAdapter } from '../server/auth/password-change-http.mjs'
import { PasswordChangeError } from '../server/auth/password-change.mjs'

const origin = 'https://office.example.test'
const cookie = '__Host-dyoffice_session=' + 'A'.repeat(43) + '; Path=/; HttpOnly; Secure; SameSite=Lax'
const data = { currentPassword: 'Existing strong password 2026', newPassword: 'Changed strong password 2027' }
const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-DyOffice-CSRF': 'bound-token' }
async function fixture(t) {
  const calls = []
  let error
  const service = { async changePassword(request, input) {
    calls.push({ input, csrf: request.headers['x-dyoffice-csrf'] })
    if (error) throw error
    return { cookie, sessionId: 'never-in-json', expiresAt: 'never-in-json' }
  } }
  const adapter = createPasswordChangeHttpAdapter({ service, trustedOrigin: origin, bodyTimeoutMs: 100 })
  const server = createServer(async (req, res) => {
    if (!await adapter(req, res)) { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { url: `http://127.0.0.1:${server.address().port}/api/v1/auth/change-password`, calls, setError(e) { error = e } }
}

test('change-password sets replacement cookie only in headers and returns a secret-free no-store DTO', async t => {
  const f = await fixture(t)
  const response = await fetch(f.url, { method: 'POST', headers, body: JSON.stringify(data) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), cookie)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(f.calls, [{ input: data, csrf: 'bound-token' }])
})

test('missing, foreign and duplicate origins are rejected before password processing', async t => {
  const f = await fixture(t)
  for (const bad of [undefined, 'null', 'https://office.example.test.evil.test']) {
    const h = { ...headers }; if (bad === undefined) delete h.Origin; else h.Origin = bad
    assert.equal((await fetch(f.url, { method: 'POST', headers: h, body: JSON.stringify(data) })).status, 403)
  }
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url, { method: 'POST', headers: { ...headers, Origin: [origin, origin] } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    }); req.on('error', reject); req.end(JSON.stringify(data))
  })
  assert.equal(status, 403)
  assert.equal(f.calls.length, 0)
})

test('rejects extra owner fields, malformed JSON, arrays and wrong media type', async t => {
  const f = await fixture(t)
  for (const body of ['{', '[]', JSON.stringify({ ...data, userId: 'other' }), '{}']) {
    assert.equal((await fetch(f.url, { method: 'POST', headers, body })).status, 400)
  }
  assert.equal((await fetch(f.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify(data) })).status, 415)
  assert.equal(f.calls.length, 0)
})

test('rejects both declared and streamed oversized request bodies with 413', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.url, { method: 'POST', headers, body: 'x'.repeat(9000) })).status, 413)
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url, { method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    }); req.on('error', reject); req.write('x'.repeat(5000)); req.end('y'.repeat(4000))
  })
  assert.equal(status, 413)
  assert.equal(f.calls.length, 0)
})

test('times out an unfinished body without invoking the credential service', async t => {
  const f = await fixture(t)
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url, { method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => { resolve(res.statusCode); req.destroy() })
    }); req.on('error', reject); req.write('{')
  })
  assert.equal(status, 408)
  assert.equal(f.calls.length, 0)
})

test('uses explicit error statuses but never exposes upstream details or sends a cookie on failure', async t => {
  const f = await fixture(t)
  for (const [error, expected] of [
    [new PasswordChangeError('UNAUTHORIZED'), 401], [new PasswordChangeError('FORBIDDEN'), 403],
    [new PasswordChangeError('INVALID_CREDENTIALS'), 401], [new PasswordChangeError('RATE_LIMITED'), 429],
    [new PasswordChangeError('AUTHENTICATION_CHANGED'), 409], [new Error('secret-db-password'), 503],
  ]) {
    f.setError(error)
    const response = await fetch(f.url, { method: 'POST', headers, body: JSON.stringify(data) })
    assert.equal(response.status, expected)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal((await response.text()).includes('secret-db-password'), false)
  }
})

test('isolates its own route and rejects unsafe origin configuration', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.url)).status, 405)
  assert.equal((await fetch(f.url + '?token=ignored', { method: 'POST', headers })).status, 400)
  assert.equal((await fetch(f.url + '-other')).status, 404)
  assert.throws(() => createPasswordChangeHttpAdapter({ service: {}, trustedOrigin: origin }), TypeError)
  assert.throws(() => createPasswordChangeHttpAdapter({ service: { changePassword() {} }, trustedOrigin: 'http://external.test' }), TypeError)
})
