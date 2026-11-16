import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCsrfToken } from './csrf.ts'
const token = 'a'.repeat(43)
test('QA proof transport forces same-origin and rejects unsafe responses', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (path, init) => {
      assert.equal(path, '/api/v1/auth/csrf')
      assert.equal(init.mode, 'same-origin')
      assert.equal(init.redirect, 'error')
      assert.equal(init.credentials, 'same-origin')
      assert.equal(init.cache, 'no-store')
      return Response.json({ csrfToken: token })
    }
    assert.equal(await getCsrfToken(), token)
    for (const response of [
      Response.json({ csrfToken: 'wrong' }),
      new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
      new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
    ]) {
      globalThis.fetch = async () => response
      await assert.rejects(getCsrfToken())
    }
    const redirect = Response.json({ csrfToken: token })
    Object.defineProperty(redirect, 'redirected', { value: true })
    globalThis.fetch = async () => redirect
    await assert.rejects(getCsrfToken())
  } finally {
    globalThis.fetch = original
  }
})
