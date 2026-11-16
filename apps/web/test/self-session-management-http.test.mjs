import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as rawRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createSelfSessionHttpAdapter } from '../server/auth/self-session-management-http.mjs'
import { CLEAR_SESSION_COOKIE } from '../server/auth/session-core.mjs'
const origin = 'https://office.example.test', target = randomUUID()
async function fixture(t) {
  const state = { calls: [], error: null, current: false }
  const service = {
    async list(req, options) { state.calls.push(['list', options]); if (state.error) throw state.error; return { sessions: [], nextCursor: null } },
    async revoke(req, input) { state.calls.push(['revoke', input]); if (state.error) throw state.error; return { currentRevoked: state.current } },
    async revokeOthers(req) { state.calls.push(['others']); if (state.error) throw state.error; return { currentRevoked: false } },
  }
  const handler = createSelfSessionHttpAdapter({ service, trustedOrigin: origin })
  const server = createServer(async (req, res) => {
    try { if (!await handler(req, res)) { res.writeHead(404); res.end() } }
    catch { res.writeHead(500); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return { state, base: `http://127.0.0.1:${server.address().port}/api/v1/auth/sessions` }
}

test('session listing parses bounded query parameters and returns no-store without CORS', async t => {
  const f = await fixture(t)
  const response = await fetch(f.base + '?limit=2&before=' + target)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.deepEqual(await response.json(), { sessions: [], nextCursor: null })
  assert.deepEqual(f.state.calls, [['list', { limit: 2, before: target }]])
})

test('rejects unknown/duplicate queries, bad cursors and bodies before invoking the service', async t => {
  const f = await fixture(t)
  for (const query of ['?ownerId=x', '?limit=1&limit=2', '?limit=0', '?limit=101', '?limit=1e2', '?before=bad']) {
    assert.equal((await fetch(f.base + query)).status, 400, query)
  }
  assert.equal((await fetch(f.base + '/revoke-others?ownerId=x', { method: 'POST', headers: { Origin: origin } })).status, 400)
  assert.equal((await fetch(f.base + '/' + target, { method: 'DELETE', headers: { Origin: origin }, body: '{}' })).status, 400)
  assert.equal(f.state.calls.length, 0)
})

test('write requests require an exact single trusted Origin', async t => {
  const f = await fixture(t)
  for (const sent of [undefined, 'null', 'https://office.example.test.evil.test']) {
    const response = await fetch(f.base + '/' + target, { method: 'DELETE', headers: sent ? { Origin: sent } : {} })
    assert.equal(response.status, 403)
  }
  const status = await new Promise((resolve, reject) => {
    const req = rawRequest(f.base + '/' + target, { method: 'DELETE', headers: { Origin: [origin, origin] } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject); req.end()
  })
  assert.equal(status, 403)
  assert.equal(f.state.calls.length, 0)
})

test('DELETE and revoke-others return 204; cookie is cleared only after committed self revocation', async t => {
  const f = await fixture(t)
  const send = () => fetch(f.base + '/' + target, { method: 'DELETE', headers: { Origin: origin } })
  const other = await send()
  assert.equal(other.status, 204); assert.equal(await other.text(), '')
  assert.equal(other.headers.get('set-cookie'), null)
  f.state.current = true
  const own = await send()
  assert.equal(own.status, 204); assert.equal(own.headers.get('set-cookie'), CLEAR_SESSION_COOKIE)
  const remaining = await fetch(f.base + '/revoke-others', { method: 'POST', headers: { Origin: origin } })
  assert.equal(remaining.status, 204); assert.equal(remaining.headers.get('set-cookie'), null)
  assert.deepEqual(f.state.calls.at(-1), ['others'])
})

test('permission and transaction failures are secret-free and never emit a clearing cookie', async t => {
  const f = await fixture(t)
  for (const [code, status] of [['UNAUTHORIZED', 401], ['FORBIDDEN', 403], ['INVALID_CURSOR', 400], ['UNAVAILABLE', 503], ['SQL_DETAIL', 503]]) {
    f.state.error = Object.assign(new Error('do-not-expose database and token'), { code })
    const response = await fetch(f.base + '/' + target, { method: 'DELETE', headers: { Origin: origin } })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal((await response.text()).includes('do-not-expose'), false)
  }
})

test('unrelated routes are untouched, wrong methods rejected, unsafe configuration denied', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.base + '/other-route')).status, 404)
  const response = await fetch(f.base, { method: 'POST' })
  assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET')
  assert.throws(() => createSelfSessionHttpAdapter({}), TypeError)
  const service = { list() {}, revoke() {}, revokeOthers() {} }
  for (const bad of ['http://remote.example', 'https://office.example.test/path', 'https://user:pass@office.example.test']) {
    assert.throws(() => createSelfSessionHttpAdapter({ service, trustedOrigin: bad }), TypeError)
  }
})
