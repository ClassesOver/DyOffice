import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createCsrfService, SESSION_COOKIE } from '../../server/src/modules/auth/csrf.ts'
import * as routes from '../../server/src/modules/commands/routes.ts'
const id = '11111111-1111-4111-8111-111111111111',
  token = 'x'.repeat(43),
  origin = 'https://office.example'
const envelope = {
  commandId: id,
  fileId: id,
  baseRevision: id,
  editorGeneration: 0,
  leaseEpoch: 1,
  argsHash: 'a'.repeat(64),
  payload: { toolName: 'replace', arguments: {} },
}
async function fixture(t) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } })
  t.after(() => app.close())
  const calls = []
  const csrf = createCsrfService({ db: {}, deploymentId: id, origin, key: 'k'.repeat(32) })
  routes.registerCommandRoutes(app, {
    sessions: {
      authenticate: async (x) => {
        assert.equal(x, token)
      },
    },
    csrf,
    createRequestCommands: (c) => {
      calls.push(c)
      return {
        service: {
          proposeCommand: async (e) => ({ envelope: e, state: 'pending_approval' }),
          approveCommand: async (e, d) => ({ envelope: e, digest: d, state: 'approved' }),
        },
        bindCommandUpload: async () => {
          throw Error('unexpected')
        },
      }
    },
  })
  return {
    app,
    calls,
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin,
      'x-csrf-token': csrf.sessionToken(token),
    },
  }
}
test('command HTTP boundary requires session CSRF and same origin before factory', async (t) => {
  assert.equal(typeof routes.registerCommandRoutes, 'function')
  const f = await fixture(t)
  for (const headers of [
    {},
    { cookie: f.headers.cookie },
    { ...f.headers, origin: 'https://evil.example' },
  ]) {
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/commands/propose',
      headers,
      payload: { editorId: id, currentGeneration: 0, envelope },
    })
    assert.ok([401, 403].includes(r.statusCode))
  }
  assert.equal(f.calls.length, 0)
})
test('strict action allowlist rejects extra approval fields and unbounded body', async (t) => {
  const f = await fixture(t)
  for (const [action, body] of [
    ['executeAnything', { editorId: id, currentGeneration: 0, envelope }],
    ['propose', { editorId: id, currentGeneration: 0, envelope, approved: true }],
    ['approve', { editorId: id, currentGeneration: 0, envelope, digest: 'bad' }],
  ]) {
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/commands/' + action,
      headers: f.headers,
      payload: body,
    })
    assert.ok([400, 404].includes(r.statusCode), r.body)
  }
  assert.equal(f.calls.length, 0)
})
test('proposal stays pending; approval is a distinct authenticated request', async (t) => {
  const f = await fixture(t)
  const body = { editorId: id, currentGeneration: 0, envelope }
  let r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/commands/propose',
    headers: f.headers,
    payload: body,
  })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().state, 'pending_approval')
  assert.match(r.headers['cache-control'], /no-store/)
  r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/commands/approve',
    headers: f.headers,
    payload: { ...body, digest: 'b'.repeat(64) },
  })
  assert.equal(r.json().state, 'approved')
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[0], { token, editorId: id, editorGeneration: 0 })
})
test('oversized command arguments are rejected before service construction', async (t) => {
  const f = await fixture(t)
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/commands/propose',
    headers: f.headers,
    payload: {
      editorId: id,
      currentGeneration: 0,
      envelope: {
        ...envelope,
        payload: { toolName: 'replace', arguments: { text: 'x'.repeat(71000) } },
      },
    },
  })
  assert.equal(r.statusCode, 413)
  assert.equal(f.calls.length, 0)
})
