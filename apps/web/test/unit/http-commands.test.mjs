import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as client from '../../../../packages/browser-host/src/http-commands.ts'
const envelope = {
  commandId: 'cmd',
  fileId: 'file',
  baseRevision: 'r1',
  editorGeneration: 1,
  leaseEpoch: 1,
  argsHash: 'a'.repeat(64),
  payload: { toolName: 'replace', arguments: { text: 'ok' } },
}
test('client sends same-origin CSRF and explicit request actions, not provider-approved flags', async () => {
  assert.equal(typeof client.createHttpCommandClient, 'function')
  let calls = []
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'proof',
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return Response.json({ state: 'pending_approval', digest: 'b'.repeat(64), envelope })
    },
  })
  const p = await c.proposeCommand(envelope)
  assert.equal(p.state, 'pending_approval')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/commands/propose')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(calls[0].options.headers['x-csrf-token'], 'proof')
  assert.equal(JSON.parse(calls[0].options.body).approved, undefined)
})
test('client rejects forged response envelope and disposal fences request', async () => {
  let calls = 0
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'proof',
    fetchImpl: async () => {
      calls++
      return Response.json({
        state: 'approved',
        digest: 'b'.repeat(64),
        envelope: { ...envelope, argsHash: 'c'.repeat(64) },
      })
    },
  })
  await assert.rejects(c.approveCommand(envelope, 'b'.repeat(64)))
  c.dispose()
  await assert.rejects(c.proposeCommand(envelope))
  assert.equal(calls, 1)
})
test('client accepts equivalent PostgreSQL JSONB key order without accepting changed values', async () => {
  const reordered = Object.fromEntries(Object.entries(envelope).reverse())
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'proof',
    fetchImpl: async () =>
      Response.json({ state: 'approved', digest: 'b'.repeat(64), envelope: reordered }),
  })
  assert.equal((await c.approveCommand(envelope, 'b'.repeat(64))).state, 'approved')
})
test('dispose while response body is pending rejects the late approval', async () => {
  let release, entered
  const ready = new Promise((r) => (entered = r))
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'proof',
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => {
        entered()
        await new Promise((r) => (release = r))
        return JSON.stringify({ state: 'approved', digest: 'b'.repeat(64), envelope })
      },
    }),
  })
  const p = c.approveCommand(envelope, 'b'.repeat(64))
  await ready
  c.dispose()
  release()
  await assert.rejects(p)
})
