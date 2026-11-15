import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication } from '../../server/application.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function shellConfig(extra = {}) {
  return {
    env: 'test',
    logger: false,
    rateLimit: { max: 20, windowMs: 60_000 },
    readyCheck: async () => true,
    ...extra,
  }
}

async function loadBuildApp() {
  try {
    return await import('../../server/src/app.mjs')
  } catch (error) {
    assert.fail(`T02 modular API is not implemented (${error.code ?? error.name}: ${error.message})`)
  }
}

test('legacy file, preference, and admin routes keep status codes and omit secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-api-compat-'))
  const server = await createApplication({
    directory,
    userToken: 'personal',
    adminToken: 'admin',
    encryptionKey: 'test-only-encryption-key',
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const personal = { authorization: 'Bearer personal', 'content-type': 'application/json' }
  const admin = { authorization: 'Bearer admin', 'content-type': 'application/json' }

  const anonymous = await fetch(`${base}/api/preferences`)
  assert.equal(anonymous.status, 401)
  const anonymousBody = await anonymous.json()
  assert.equal(anonymousBody.error, '请登录')
  assert.equal(anonymousBody.status, 401)
  assert.equal(anonymousBody.detail, '请登录')
  assert.match(anonymous.headers.get('x-request-id'), UUID)
  assert.equal(anonymousBody.requestId, anonymous.headers.get('x-request-id'))

  const wrongToken = await fetch(`${base}/api/files`, { headers: { authorization: 'Bearer wrong-token' } })
  assert.equal(wrongToken.status, 401)
  assert.equal(JSON.stringify(await wrongToken.json()).includes('wrong-token'), false)

  const personalAdmin = await fetch(`${base}/api/admin/config`, { headers: personal })
  assert.equal(personalAdmin.status, 403)
  assert.equal((await personalAdmin.json()).error, '需要管理员权限')

  const uploaded = await fetch(`${base}/api/files`, {
    method: 'POST',
    headers: { authorization: 'Bearer personal', 'x-file-name': 'private.pdf' },
    body: '%PDF-1.7 personal bytes',
  })
  assert.equal(uploaded.status, 201)
  const file = await uploaded.json()
  for (const path of ['/api/files', `/api/files/${file.id}`, '/api/preferences', '/api/sources']) {
    const response = await fetch(base + path, { headers: admin })
    assert.equal(response.status, 403, path)
    assert.equal(JSON.stringify(await response.json()).includes('private.pdf'), false)
  }

  const saved = await fetch(`${base}/api/admin/config`, {
    method: 'PUT',
    headers: admin,
    body: JSON.stringify({
      models: [{ id: 'primary', model: 'gpt-4.1', baseUrl: 'https://example.com/v1', apiKey: 'super-secret-value', enabled: true }],
    }),
  })
  assert.equal(saved.status, 200)
  const adminView = await saved.json()
  assert.equal(JSON.stringify(adminView).includes('super-secret-value'), false)
  assert.equal(adminView.models[0].hasKey, true)
  assert.equal(adminView.models[0].apiKey, undefined)
  assert.equal(adminView.models[0].secret, undefined)

  const catalog = await fetch(`${base}/api/models`, { headers: personal })
  assert.equal(catalog.status, 200)
  assert.equal(JSON.stringify(await catalog.json()).includes('super-secret-value'), false)

  const sourceWrite = await fetch(`${base}/api/sources`, {
    method: 'PUT',
    headers: personal,
    body: JSON.stringify({ name: 'notes', url: 'https://example.com/data', apiKey: 'source-secret-value' }),
  })
  assert.equal(sourceWrite.status, 200)
  const sources = await (await fetch(`${base}/api/sources`, { headers: personal })).json()
  assert.equal(JSON.stringify(sources).includes('source-secret-value'), false)
  assert.equal(sources[0].hasKey, true)
  assert.equal(sources[0].secret, undefined)
})

test('modular buildApp serves health, problem errors, limits, and explicit migration responses', async () => {
  const { buildApp } = await loadBuildApp()
  const app = await buildApp(shellConfig())
  app.get('/api/v1/boom', async () => {
    throw new Error('token=abc path=/var/secret')
  })

  const live = await app.inject({
    method: 'GET',
    url: '/api/v1/health/live',
    headers: { 'x-request-id': 'client-secret-id', 'request-id': 'also-secret' },
  })
  assert.equal(live.statusCode, 200)
  assert.deepEqual(live.json(), { state: 'alive' })
  assert.match(live.headers['x-request-id'], UUID)
  assert.notEqual(live.headers['x-request-id'], 'client-secret-id')
  assert.equal(live.headers['cache-control'], 'no-store')
  assert.equal(live.headers['x-content-type-options'], 'nosniff')
  assert.equal(JSON.stringify(live.json()).includes('client-secret-id'), false)

  const head = await app.inject({ method: 'HEAD', url: '/api/v1/health/live' })
  assert.equal(head.statusCode, 200)
  assert.equal(head.body, '')

  const posted = await app.inject({ method: 'POST', url: '/api/v1/health/live' })
  assert.equal(posted.statusCode, 405)
  assert.match(posted.headers.allow, /GET/)
  assert.match(posted.headers.allow, /HEAD/)
  assert.equal(posted.json().status, 405)
  assert.equal(posted.json().error, 'Method not allowed')
  assert.equal(posted.json().requestId, posted.headers['x-request-id'])

  const leakedQuery = await app.inject({ method: 'GET', url: '/api/v1/health/live?token=super-secret-value' })
  assert.equal(leakedQuery.statusCode, 400)
  const leakedBody = leakedQuery.json()
  assert.equal(leakedBody.status, 400)
  assert.equal(leakedBody.type, 'about:blank')
  assert.equal(JSON.stringify(leakedBody).includes('super-secret-value'), false)
  assert.equal(leakedBody.requestId, leakedQuery.headers['x-request-id'])
  assert.notEqual(leakedBody.requestId, 'client-secret-id')

  const unready = await buildApp(shellConfig({
    readyCheck: async () => {
      throw new Error('password=hunter2 path=/var/lib/dyoffice')
    },
  }))
  const ready = await unready.inject({ method: 'GET', url: '/api/v1/health/ready' })
  assert.equal(ready.statusCode, 503)
  assert.deepEqual(ready.json(), { state: 'unavailable' })
  assert.equal(JSON.stringify(ready.json()).includes('hunter2'), false)
  assert.equal(JSON.stringify(ready.json()).includes('/var/lib'), false)
  const stillLive = await unready.inject({ method: 'GET', url: '/api/v1/health/live' })
  assert.equal(stillLive.statusCode, 200)
  assert.deepEqual(stillLive.json(), { state: 'alive' })
  await unready.close()

  const migrated = await app.inject({
    method: 'GET',
    url: '/api/preferences',
    headers: { 'x-request-id': 'client-secret-id' },
  })
  assert.equal(migrated.statusCode, 501)
  assert.equal(migrated.json().error, '接口尚未迁移到模块化 API')
  assert.equal(migrated.json().status, 501)
  assert.equal(JSON.stringify(migrated.json()).includes('theme'), false)
  assert.notEqual(migrated.json().requestId, 'client-secret-id')

  const adminRoute = await app.inject({ method: 'GET', url: '/api/admin/config' })
  assert.equal(adminRoute.statusCode, 501)
  assert.equal(JSON.stringify(adminRoute.json()).includes('apiKey'), false)

  const missingPage = await app.inject({ method: 'GET', url: '/missing?secret=private' })
  assert.equal(missingPage.statusCode, 404)
  assert.equal(JSON.stringify(missingPage.json()).includes('private'), false)

  const boom = await app.inject({ method: 'GET', url: '/api/v1/boom' })
  assert.equal(boom.statusCode, 500)
  assert.equal(boom.json().detail, '服务器内部错误')
  assert.equal(JSON.stringify(boom.json()).includes('token=abc'), false)
  assert.equal(JSON.stringify(boom.json()).includes('/var/secret'), false)

  const oversized = await app.inject({
    method: 'POST',
    url: '/api/preferences',
    headers: { 'content-type': 'application/json' },
    payload: 'x'.repeat(1024 * 1024 + 1),
  })
  assert.equal(oversized.statusCode, 413)
  assert.equal(oversized.json().status, 413)
  assert.equal(JSON.stringify(oversized.json()).includes('xxxxx'), false)

  const limited = await buildApp(shellConfig({ rateLimit: { max: 2, windowMs: 60_000 } }))
  assert.equal((await limited.inject({ method: 'GET', url: '/api/preferences' })).statusCode, 501)
  assert.equal((await limited.inject({
    method: 'GET',
    url: '/api/preferences',
    headers: { 'x-forwarded-for': '203.0.113.8' },
  })).statusCode, 501)
  const blocked = await limited.inject({
    method: 'GET',
    url: '/api/preferences',
    headers: { 'x-forwarded-for': '203.0.113.9' },
  })
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.json().status, 429)
  assert.match(blocked.headers['retry-after'], /^[1-9][0-9]*$/)
  assert.equal(JSON.stringify(blocked.json()).includes('x-forwarded-for'), false)
  assert.equal((await limited.inject({ method: 'GET', url: '/api/v1/health/live' })).statusCode, 200)
  await limited.close()

  await assert.rejects(
    () => buildApp(shellConfig({ env: 'production' })),
    /production/,
  )
  await assert.rejects(
    () => buildApp(shellConfig({ schema: { type: 'object' } })),
    /Unsupported/,
  )

  await app.close()
  await assert.rejects(() => app.inject({ method: 'GET', url: '/api/v1/health/live' }))
})

test('production process environment cannot construct the modular shell', async () => {
  await loadBuildApp()
  const script = `
    const { buildApp } = await import('./server/src/app.mjs')
    try {
      await buildApp({
        env: 'test',
        logger: false,
        rateLimit: { max: 2, windowMs: 1000 },
        readyCheck: async () => true,
      })
      console.error('constructed')
      process.exit(2)
    } catch (error) {
      if (!/production/.test(error.message)) {
        console.error(error)
        process.exit(3)
      }
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('modular shell closes its listening socket', async () => {
  const { buildApp } = await loadBuildApp()
  const app = await buildApp(shellConfig())
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${app.server.address().port}`
  assert.equal((await fetch(`${base}/api/v1/health/ready`)).status, 200)
  await app.close()
  await assert.rejects(fetch(`${base}/api/v1/health/live`))
})
