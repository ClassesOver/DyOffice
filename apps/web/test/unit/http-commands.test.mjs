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
    getCsrfToken: async () => 'p'.repeat(43),
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
  assert.equal(calls[0].options.headers['x-csrf-token'], 'p'.repeat(43))
  assert.equal(JSON.parse(calls[0].options.body).approved, undefined)
})
test('client rejects forged response envelope and disposal fences request', async () => {
  let calls = 0
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'p'.repeat(43),
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
    getCsrfToken: async () => 'p'.repeat(43),
    fetchImpl: async () =>
      Response.json({ state: 'approved', digest: 'b'.repeat(64), envelope: reordered }),
  })
  assert.equal((await c.approveCommand(envelope, 'b'.repeat(64))).state, 'approved')
})
test('dispose while response stream is pending cancels and rejects late approval', async () => {
  let entered,
    cancelled = false
  const ready = new Promise((r) => (entered = r))
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'p'.repeat(43),
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            entered()
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  })
  const pending = c.approveCommand(envelope, 'b'.repeat(64))
  await ready
  c.dispose()
  // The client must not leave a stalled reader waiting after disposal.
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(Error('test timeout')), 300)),
    ]),
    (e) => e.message !== 'test timeout',
  )
  assert.equal(cancelled, true)
})

test('requests forbid cross-origin mode and redirects', async () => {
  let opts
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'p'.repeat(43),
    fetchImpl: async (_, o) => {
      opts = o
      return Response.json({ state: 'pending_approval', digest: 'b'.repeat(64), envelope })
    },
  })
  await c.proposeCommand(envelope)
  assert.equal(opts.mode, 'same-origin')
  assert.equal(opts.redirect, 'error')
  assert.ok(opts.signal instanceof AbortSignal)
})
test('invalid CSRF never reaches fetch', async () => {
  for (const token of ['', 'short', 'a'.repeat(44), 'a'.repeat(42) + '\n', null]) {
    let calls = 0
    const c = client.createHttpCommandClient({
      editorId: 'editor',
      currentGeneration: () => 1,
      getCsrfToken: async () => token,
      fetchImpl: async () => {
        calls++
        return Response.json({ state: 'pending_approval', digest: 'b'.repeat(64), envelope })
      },
    })
    await assert.rejects(c.proposeCommand(envelope))
    assert.equal(calls, 0)
  }
})
test('stream cap counts UTF8 bytes and cancels before unbounded completion', async () => {
  let pulls = 0,
    cancelled = false
  const chunk = new TextEncoder().encode('界'.repeat(20000))
  const c = client.createHttpCommandClient({
    editorId: 'editor',
    currentGeneration: () => 1,
    getCsrfToken: async () => 'p'.repeat(43),
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls++
            if (pulls < 5) controller.enqueue(chunk)
            else controller.close()
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  })
  await assert.rejects(c.proposeCommand(envelope))
  assert.equal(cancelled, true)
  assert.ok(pulls <= 4)
})
test('rejects redirected, wrong MIME and invalid UTF8 responses', async () => {
  for (const kind of ['redirect', 'mime', 'utf8']) {
    const c = client.createHttpCommandClient({
      editorId: 'editor',
      currentGeneration: () => 1,
      getCsrfToken: async () => 'p'.repeat(43),
      fetchImpl: async () => {
        const r =
          kind === 'utf8'
            ? new Response(new Uint8Array([0xff]), {
                headers: { 'content-type': 'application/json' },
              })
            : Response.json({ state: 'pending_approval', digest: 'b'.repeat(64), envelope })
        if (kind === 'redirect') Object.defineProperty(r, 'redirected', { value: true })
        if (kind === 'mime') r.headers.set('content-type', 'text/application/json-malicious')
        return r
      },
    })
    await assert.rejects(c.proposeCommand(envelope))
  }
})

const tick = () => new Promise(r => setTimeout(r, 0))
test('dispose settles stalled CSRF without dispatching its late token', async () => {
  let token, calls = 0
  const c = client.createHttpCommandClient({
    editorId: 'editor', currentGeneration: () => 1,
    getCsrfToken: () => new Promise(r => { token = r }),
    fetchImpl: async () => { calls++; return Response.json({}) },
  })
  const outcome = c.proposeCommand(envelope).then(() => 'success', () => 'stopped')
  c.dispose()
  await tick()
  assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'stopped')
  token('p'.repeat(43))
  await tick()
  assert.equal(calls, 0)
})
test('dispose settles stalled execution fetch and cleans late claim without replay', async () => {
  let reply, calls = 0, cancelled = 0
  const c = client.createHttpCommandClient({
    editorId: 'editor', currentGeneration: () => 1,
    getCsrfToken: async () => 'p'.repeat(43),
    fetchImpl: () => { calls++; return new Promise(r => { reply = r }) },
  })
  const outcome = c.beginExecution(envelope, 'b'.repeat(64)).then(() => 'success', () => 'stopped')
  await tick()
  c.dispose()
  await tick()
  assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'stopped')
  reply(new Response(new ReadableStream({ cancel() { cancelled++ } })))
  await tick()
  assert.equal(calls, 1)
  assert.equal(cancelled, 1)
})
test('dispose does not await an uncooperative stream cancel', async () => {
  const c = client.createHttpCommandClient({
    editorId: 'editor', currentGeneration: () => 1,
    getCsrfToken: async () => 'p'.repeat(43),
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { return new Promise(() => {}) },
    }), { headers: { 'content-type': 'application/json' } }),
  })
  const outcome = c.proposeCommand(envelope).then(() => 'success', () => 'stopped')
  await tick()
  c.dispose()
  await tick()
  assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'stopped')
})
test('dispose in the response-arrival window releases the body', async () => {
  let reply, cancelled = 0
  const raw = new Promise(r => { reply = r })
  const c = client.createHttpCommandClient({
    editorId: 'editor', currentGeneration: () => 1,
    getCsrfToken: async () => 'p'.repeat(43), fetchImpl: () => raw,
  })
  const pending = c.beginExecution(envelope, 'b'.repeat(64))
  await tick()
  raw.then(() => c.dispose())
  reply(new Response(new ReadableStream({ cancel() { cancelled++ } })))
  await assert.rejects(pending)
  assert.equal(cancelled, 1)
})
test('late rejected token after dispose remains observed and never dispatches', async () => {
  let reject, calls = 0
  const c = client.createHttpCommandClient({
    editorId: 'editor', currentGeneration: () => 1,
    getCsrfToken: () => new Promise((_, r) => { reject = r }),
    fetchImpl: async () => { calls++; return Response.json({}) },
  })
  const pending = c.approveCommand(envelope, 'b'.repeat(64))
  c.dispose()
  await assert.rejects(pending, /disposed/)
  reject(Error('late token error'))
  await tick()
  assert.equal(calls, 0)
})

 test('abandoned outcome is readable but cannot become an execution claim', async () => {
  let calls=0
  const c=client.createHttpCommandClient({editorId:'editor',currentGeneration:()=>1,getCsrfToken:async()=> 'p'.repeat(43),fetchImpl:async()=> { calls++; return Response.json({state:'abandoned_uncommitted',digest:'b'.repeat(64),envelope}) }})
  assert.equal((await c.getCommandOutcome(envelope)).state,'abandoned_uncommitted')
  await assert.rejects(c.beginExecution(envelope,'b'.repeat(64)), /execution claim/)
  assert.equal(calls,2)
  c.dispose()
 })
