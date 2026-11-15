import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Fastify shell serves legacy preference and admin contracts when a workspace is attached', async (t) => {
  let buildApp
  let createLegacyContext
  try {
    ;({ buildApp } = await import('../../server/src/app.mjs'))
    ;({ createLegacyContext } = await import('../../server/src/legacy-context.mjs'))
  } catch (error) {
    assert.fail(`T02 route cutover is not implemented (${error.code ?? error.name}: ${error.message})`)
  }
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-cutover-'))
  const context = await createLegacyContext({
    directory,
    userToken: 'personal',
    adminToken: 'admin',
    encryptionKey: 'test-only-encryption-key',
  })
  const app = await buildApp({
    env: 'test',
    logger: false,
    rateLimit: { max: 50, windowMs: 60_000 },
    readyCheck: () => context.ready(),
    legacy: context,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const personal = { authorization: 'Bearer personal', 'content-type': 'application/json' }
  const admin = { authorization: 'Bearer admin', 'content-type': 'application/json' }

  const preferences = await fetch(`${base}/api/preferences`, { headers: personal })
  assert.equal(preferences.status, 200)
  assert.equal((await preferences.json()).theme, 'system')
  assert.match(preferences.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i)

  const saved = await fetch(`${base}/api/admin/config`, {
    method: 'PUT',
    headers: admin,
    body: JSON.stringify({
      models: [{ id: 'primary', model: 'gpt-4.1', baseUrl: 'https://example.com/v1', apiKey: 'super-secret-value', enabled: true }],
    }),
  })
  assert.equal(saved.status, 200)
  assert.equal(JSON.stringify(await saved.json()).includes('super-secret-value'), false)

  const health = await fetch(`${base}/api/v1/health/live`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { state: 'alive' })

  const missing = await fetch(`${base}/api/missing?secret=private`, { headers: personal })
  assert.equal(missing.status, 404)
  const missingBody = await missing.json()
  assert.equal(missingBody.error, '接口不存在')
  assert.equal(JSON.stringify(missingBody).includes('private'), false)
})
