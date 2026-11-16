import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
const { registerCommandRecoveryRoutes } =
  await import('../../server/src/modules/commands/recovery-routes.ts').catch((e) => {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw e
  })
const fileId = '11111111-1111-4111-8111-111111111111',
  commandId = '22222222-2222-4222-8222-222222222222',
  digest = 'a'.repeat(64),
  token = 'a'.repeat(43)
test('optional recovery routes enforce authentication and narrow input before factory', async (t) => {
  assert.equal(typeof registerCommandRecoveryRoutes, 'function')
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } })
  t.after(() => app.close())
  let calls = 0
  registerCommandRecoveryRoutes(app, {
    sessions: { authenticate: async () => {} },
    csrf: {
      requireSession: (request) => {
        if (request.headers['x-csrf-token'] !== 'proof')
          throw Object.assign(Error('csrf'), { statusCode: 403 })
      },
    },
    createRequestRecovery: () => {
      calls++
      return {
        lookup: async () => ({ fileId, commandId, digest, state: 'applied_uncommitted' }),
        abandon: async () => ({ fileId, commandId, digest, state: 'abandoned_uncommitted' }),
      }
    },
  })
  const inject = (
    body,
    headers = { cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': 'proof' },
  ) =>
    app.inject({ method: 'POST', url: '/api/v1/command-recovery/lookup', headers, payload: body })
  assert.equal((await inject({ fileId, commandId }, {})).statusCode, 401)
  assert.equal(
    (await inject({ fileId, commandId }, { cookie: '__Host-dyoffice-session=' + token }))
      .statusCode,
    403,
  )
  assert.equal((await inject({ fileId, commandId, editorId: fileId })).statusCode, 400)
  assert.equal(calls, 0)
  const r = await inject({ fileId, commandId })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.headers['cache-control'], 'private, no-store')
  assert.equal(calls, 1)
})
