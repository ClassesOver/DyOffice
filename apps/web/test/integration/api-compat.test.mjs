import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { buildApp } from '../../server/src/app.ts'

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-fastify-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const app = await buildApp({ directory, userToken: 'personal-secret', adminToken: 'admin-secret', encryptionKey: 'test-key', ...overrides })
  t.after(() => app.close())
  const origin = await app.listen({ port: 0, host: '127.0.0.1' })
  const headers = { authorization: 'Bearer personal-secret', 'content-type': 'application/json' }
  return { app, origin, directory, headers }
}

test('Fastify compatibility preserves settings authorization, writes and secret redaction', async t => {
  const { origin, headers } = await fixture(t)
  const api = (path, options) => fetch(origin + path, options)
  assert.equal((await api('/api/preferences')).status, 401)
  assert.equal((await api('/api/preferences', { headers: { authorization: 'Bearer admin-secret' } })).status, 403)
  assert.equal((await api('/api/admin/config', { headers })).status, 403)
  const changed = await api('/api/preferences', { method: 'PUT', headers, body: JSON.stringify({ theme: 'dark' }) })
  assert.equal(changed.status, 200)
  assert.equal((await changed.json()).theme, 'dark')
  assert.equal((await (await api('/api/preferences', { headers })).json()).theme, 'dark')
  const adminHeaders = { ...headers, authorization: 'Bearer admin-secret' }
  const configured = await api('/api/admin/config', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ models: [{ id: 'm', model: 'model', baseUrl: 'https://example.com/v1', apiKey: 'provider-private-key' }] }) })
  assert.equal(configured.status, 200)
  assert.equal((await configured.json()).models[0].hasKey, true)
  const text = await (await api('/api/admin/config', { headers: adminHeaders })).text()
  assert.equal(text.includes('provider-private-key'), false)
  assert.equal(text.includes('secret'), false)
})

test('Fastify compatibility retains exact binary uploads and versioned read contracts', async t => {
  const { origin, headers } = await fixture(t)
  const content = Buffer.from('PK\x03\x04native-bytes\x00\xff', 'latin1')
  const uploaded = await fetch(origin + '/api/files', { method: 'POST', headers: { authorization: headers.authorization, 'content-type': 'application/octet-stream', 'x-file-name': 'test.docx' }, body: content })
  assert.equal(uploaded.status, 201)
  const file = await uploaded.json()
  const metadata = await fetch(origin + '/api/v1/files/' + file.id, { headers })
  assert.equal(metadata.status, 200)
  const opened = await metadata.json()
  assert.match(opened.file.revision, /^sha256:/)
  const download = await fetch(origin + '/api/files/' + file.id, { headers })
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content)
  const unauthorized = await fetch(origin + '/api/v1/files/' + file.id, { headers: { authorization: 'Bearer admin-secret' } })
  assert.equal(unauthorized.status, 403)
})

test('Fastify errors retain safe Problem fields and server-owned request identifiers', async t => {
  const { origin, headers } = await fixture(t)
  const ids = new Set()
  for (const [path, options, status] of [
    ['/api/preferences', {}, 401],
    ['/api/preferences', { method: 'PUT', headers, body: '{' }, 400],
    ['/api/preferences', { method: 'PUT', headers, body: 'x'.repeat(1024 * 1024 + 10) }, 413],
    ['/api/does-not-exist?token=private-query', { headers }, 404],
    ['/api/%ZZ?token=private-query', { headers }, 400],
  ]) {
    const response = await fetch(origin + path, { ...options, headers: { ...options.headers, 'x-request-id': 'untrusted-client-id' } })
    assert.equal(response.status, status)
    const problem = await response.json()
    assert.equal(problem.status, status)
    assert.equal(problem.type, 'about:blank')
    assert.equal(problem.requestId, response.headers.get('x-request-id'))
    assert.match(problem.requestId, /^[0-9a-f-]{36}$/i)
    assert.equal(JSON.stringify(problem).includes('private-query'), false)
    ids.add(problem.requestId)
  }
  assert.equal(ids.size, 5)
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(origin + '/api/preferences', { headers: { authorization: ['Bearer personal-secret', 'Bearer admin-secret'] } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 401)
})

test('Fastify health separates liveness from storage readiness and closes its listener', async t => {
  const { app, origin, directory } = await fixture(t)
  const live = await fetch(origin + '/api/v1/health/live')
  assert.equal(live.status, 200)
  assert.deepEqual(await live.json(), { state: 'alive' })
  const head = await fetch(origin + '/api/v1/health/ready', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const wrongMethod = await fetch(origin + '/api/v1/health/live', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD')
  await rm(directory, { recursive: true, force: true })
  const unavailable = await fetch(origin + '/api/v1/health/ready')
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { state: 'unavailable' })
  assert.equal((await fetch(origin + '/api/v1/health/live')).status, 200)
  await app.close()
  assert.equal(app.server.listening, false)
})

test('Fastify refuses production before creating prototype state', async () => {
  const directory = join(tmpdir(), 'dyoffice-production-' + crypto.randomUUID())
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    await assert.rejects(() => buildApp({ directory, userToken: 'user', adminToken: 'admin', encryptionKey: 'key' }), /production/i)
    await assert.rejects(() => stat(directory), { code: 'ENOENT' })
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('Fastify rate limiting cannot be bypassed with client proxy headers and exempts probes', async t => {
  const { origin, headers } = await fixture(t, { rateLimit: { max: 2, timeWindow: 60_000 } })
  assert.equal((await fetch(origin + '/api/preferences', { headers })).status, 200)
  assert.equal((await fetch(origin + '/api/preferences', { headers })).status, 200)
  const limited = await fetch(origin + '/api/preferences', { headers: { ...headers, 'x-forwarded-for': '203.0.113.8' } })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  const problem = await limited.json()
  assert.equal(problem.status, 429)
  assert.equal(problem.requestId, limited.headers.get('x-request-id'))
  assert.equal((await fetch(origin + '/api/v1/health/live')).status, 200)
})

test('Web bootstrap handles SIGTERM with a clean exit', { timeout: 10_000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { fileURLToPath } = await import('node:url')
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-bootstrap-'))
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'development', PORT: '0', HOST: '127.0.0.1', DYOFFICE_DATA_DIR: directory, DYOFFICE_USER_TOKEN: 'test-personal', DYOFFICE_ADMIN_TOKEN: 'test-admin', DYOFFICE_ENCRYPTION_KEY: 'test-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    await rm(directory, { recursive: true, force: true })
  })
  const exit = once(child, 'exit')
  const started = await Promise.race([
    once(child.stdout, 'data'),
    exit.then(([code]) => { throw new Error(`Server exited before startup: ${code}`) }),
  ])
  assert.match(String(started[0]), /dyoffice:/)
  child.kill('SIGTERM')
  const [code, signal] = await exit
  assert.equal(signal, null)
  assert.equal(code, 0)
})

test('uncommon HTTP methods retain authorization, safe errors, health 405 and rate limits', async t => {
  const { origin, headers } = await fixture(t)
  for (const method of ['PROPFIND', 'SEARCH', 'PURGE', 'QUERY']) {
    const denied = await fetch(origin + '/api/preferences?token=private-query', { method })
    assert.equal(denied.status, 401)
    const missing = await fetch(origin + '/api/preferences?token=private-query', { method, headers })
    assert.equal(missing.status, 404)
    const problem = await missing.json()
    assert.equal(problem.status, 404)
    assert.equal(problem.requestId, missing.headers.get('x-request-id'))
    assert.equal(JSON.stringify(problem).includes('private-query'), false)
    const health = await fetch(origin + '/api/v1/health/live?token=private-query', { method })
    assert.equal(health.status, 405)
    assert.equal(health.headers.get('allow'), 'GET, HEAD')
  }
  const limited = await fixture(t, { rateLimit: { max: 1, timeWindow: 60_000 } })
  assert.equal((await fetch(limited.origin + '/api/preferences', { method: 'PROPFIND' })).status, 401)
  assert.equal((await fetch(limited.origin + '/api/preferences', { method: 'PROPFIND' })).status, 429)
})
