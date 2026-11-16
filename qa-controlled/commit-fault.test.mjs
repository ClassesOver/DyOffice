import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createCommitFaultHook } from './commit-fault.mjs'
test('lost hook masks first successful commit as 503 without receipt or a second request', async () => {
  const app = Fastify()
  let calls = 0,
    durable = false
  app.addHook(
    'onSend',
    createCommitFaultHook(() => 'lost'),
  )
  app.post('/api/v1/files/test/commits', async () => {
    calls++
    durable = true
    return { revision: 'durable-revision', sha256: 'receipt-secret' }
  })
  try {
    const first = await app.inject({ method: 'POST', url: '/api/v1/files/test/commits' })
    assert.equal(first.statusCode, 503)
    assert.equal(calls, 1)
    assert.equal(durable, true)
    assert.deepEqual(first.json(), { error: 'QA_COMMIT_RESPONSE_UNCONFIRMED' })
    assert.doesNotMatch(first.body, /durable-revision|receipt-secret/)
    const second = await app.inject({ method: 'POST', url: '/api/v1/files/test/commits' })
    assert.equal(second.statusCode, 200)
    assert.equal(calls, 2)
  } finally {
    await app.close()
  }
})
test('lost hook never converts a rejected commit to unconfirmed success', async () => {
  const app = Fastify()
  app.addHook(
    'onSend',
    createCommitFaultHook(() => 'lost'),
  )
  app.post('/api/v1/files/test/commits', async (_q, r) => r.code(409).send({ error: 'conflict' }))
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/files/test/commits' })
    assert.equal(r.statusCode, 409)
    assert.deepEqual(r.json(), { error: 'conflict' })
  } finally {
    await app.close()
  }
})
