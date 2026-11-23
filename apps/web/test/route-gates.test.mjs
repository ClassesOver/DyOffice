import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { createApplication } from './helpers/prototype-http.mjs'

test('legacy gateway exposes only minimal public health and strict Bearer permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-route-gates-'))
  const server = await createApplication({ directory, userToken: 'personal-secret', adminToken: 'admin-secret', encryptionKey: 'test-key' })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const live = await fetch(origin + '/api/v1/health/live')
  assert.equal(live.status, 200)
  assert.match(live.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i)
  const healthText = await live.text()
  assert.equal(JSON.parse(healthText).state, 'alive')
  assert.equal(healthText.includes('secret'), false)

  const ready = await fetch(origin + '/api/v1/health/ready')
  assert.equal(ready.status, 200)
  assert.equal((await ready.json()).state, 'ready')
  const head = await fetch(origin + '/api/v1/health/ready', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const method = await fetch(origin + '/api/v1/health/live', { method: 'POST' })
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('allow'), 'GET, HEAD')

  for (const authorization of ['personal-secret', 'Basic personal-secret', 'Bearer  personal-secret', 'Bearer invalid']) {
    const response = await fetch(origin + '/api/preferences', { headers: { authorization } })
    assert.equal(response.status, 401, authorization)
    const error = await response.json()
    assert.equal(error.status, 401)
    assert.equal(error.requestId, response.headers.get('x-request-id'))
  }
  assert.equal((await fetch(origin + '/api/preferences', { headers: { authorization: 'Bearer personal-secret' } })).status, 200)
  assert.equal((await fetch(origin + '/api/preferences', { headers: { authorization: 'Bearer admin-secret' } })).status, 403)
  assert.equal((await fetch(origin + '/api/admin/config', { headers: { authorization: 'Bearer personal-secret' } })).status, 403)

  // Node's rawHeaders retains the duplicate; the gateway must not pick whichever is first.
  const duplicateStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(origin + '/api/preferences', { headers: { authorization: ['Bearer personal-secret', 'Bearer admin-secret'] } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(duplicateStatus, 401)
})
