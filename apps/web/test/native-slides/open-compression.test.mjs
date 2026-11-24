import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'
import { createApiShell } from '../../server/src/framework.ts'
import { registerSlidesRoutes } from '../../server/src/modules/slides/routes.ts'

test('large presentations negotiate compression without changing slide content or error replies', async (t) => {
  const app = await createApiShell()
  t.after(() => app.close())
  const deck = {
    slides: [
      { nodes: [{ type: 'picture', dataUrl: 'data:image/png;base64,' + 'abcd'.repeat(16000) }] },
    ],
  }
  let allowed = true
  registerSlidesRoutes(
    app,
    { open: async () => deck },
    {
      authenticate: async () => {
        if (!allowed) throw Object.assign(new Error('login required'), { statusCode: 401 })
      },
    },
    { originCheck() {}, requireSession() {} },
  )
  const url = '/api/v1/files/' + randomUUID() + '/slides/open',
    payload = { revision: randomUUID(), generation: 0 }
  const post = (encoding) =>
    app.inject({ method: 'POST', url, payload, headers: { 'accept-encoding': encoding } })
  const compressed = await post('gzip, deflate, br')
  assert.equal(compressed.statusCode, 200)
  assert.equal(compressed.headers['content-encoding'], 'br')
  assert.equal(compressed.headers.vary, 'Accept-Encoding')
  assert.equal(compressed.headers['cache-control'], 'private, no-store')
  assert.deepEqual(JSON.parse(brotliDecompressSync(compressed.rawPayload)), deck)
  const raw = await post('br;q=0, identity')
  assert.equal(raw.headers['content-encoding'], undefined)
  assert.deepEqual(raw.json(), deck)
  assert.ok(compressed.rawPayload.length < raw.rawPayload.length)
  deck.slides = []
  const small = await post('br')
  assert.deepEqual(small.json(), deck)
  assert.equal(small.headers['content-encoding'], undefined)
  allowed = false
  const denied = await post('br')
  assert.equal(denied.statusCode, 401)
  assert.equal(denied.headers['content-encoding'], undefined)
})
