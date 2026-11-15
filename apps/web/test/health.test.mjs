import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveHealth } from '../server/health.mjs'

test('health probes are secret-free, honor GET/HEAD and reflect readiness', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dyoffice-health-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let fail = false
  const store = { read: () => fail ? null : { files: [], preferences: { theme: 'light' }, admin: { secret: 'never-expose' } } }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Request-ID', 'server-generated')
    const handled = await serveHealth(req, res, { path: new URL(req.url, 'http://localhost').pathname, dataDirectory: dir, store })
    if (!handled) { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const live = await fetch(base + '/api/v1/health/live')
  assert.equal(live.status, 200)
  assert.equal((await live.json()).state, 'alive')
  const ready = await fetch(base + '/api/v1/health/ready')
  assert.equal(ready.status, 200)
  const data = await ready.text()
  assert.equal(JSON.parse(data).state, 'ready')
  assert.equal(data.includes('secret'), false)
  assert.equal(ready.headers.get('cache-control'), 'no-store')
  const head = await fetch(base + '/api/v1/health/ready', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const post = await fetch(base + '/api/v1/health/live', { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  fail = true
  const failed = await fetch(base + '/api/v1/health/ready')
  assert.equal(failed.status, 503)
  assert.equal((await failed.json()).state, 'unavailable')
  assert.equal((await fetch(base + '/api/v1/health/live')).status, 200)
  assert.equal((await fetch(base + '/api/v1/no-route')).status, 404)
})
