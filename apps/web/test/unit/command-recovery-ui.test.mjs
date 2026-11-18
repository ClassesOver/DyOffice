import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const mod = await import('../../../../packages/browser-host/src/command-recovery-ui.ts').catch(
  (e) => {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw e
  },
)
const fileId = '11111111-1111-4111-8111-111111111111',
  commandId = '22222222-2222-4222-8222-222222222222',
  digest = 'a'.repeat(64)
const row = { fileId, commandId, digest, state: 'applied_uncommitted' }
const tick = () => new Promise((r) => setTimeout(r, 0))
test('recovery client only sends fixed same-origin lookup and explicit digest abandonment', async () => {
  assert.equal(typeof mod.createHttpCommandRecoveryClient, 'function')
  const calls = []
  const c = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43),
    fetchImpl: async (url, init) => {
      calls.push([url, init])
      return Response.json({
        ...row,
        state: calls.length === 1 ? 'applied_uncommitted' : 'abandoned_uncommitted',
      })
    },
  })
  assert.deepEqual(await c.lookup(fileId, commandId), row)
  await c.abandon(fileId, commandId, digest)
  assert.equal(calls.length, 2)
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['/api/v1/command-recovery/lookup', '/api/v1/command-recovery/abandon'],
  )
  assert.deepEqual(JSON.parse(calls[1][1].body), { fileId, commandId, observedDigest: digest })
  assert.equal(calls[0][1].credentials, 'same-origin')
})
test('recovery response rejects capabilities, identity changes and unverifiable committed ref', async () => {
  for (const bad of [
    { ...row, claimId: 'secret' },
    { ...row, fileId: commandId },
    { ...row, state: 'committed' },
    { ...row, state: 'future' },
  ]) {
    const c = mod.createHttpCommandRecoveryClient({
      getCsrfToken: async () => 'c'.repeat(43),
      fetchImpl: async () => Response.json(bad),
    })
    await assert.rejects(c.lookup(fileId, commandId))
  }
})
test('mutation network error has no automatic retry', async () => {
  let calls = 0
  const c = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43),
    fetchImpl: async () => {
      calls++
      throw Error('lost')
    },
  })
  await assert.rejects(c.abandon(fileId, commandId, digest))
  assert.equal(calls, 1)
})
test('panel requires explicit review plus click; shows abandonment is not undo', async () => {
  const dom = new JSDOM('<main></main>'),
    root = dom.window.document.querySelector('main')
  let calls = 0
  const panel = mod.mountCommandRecoveryPanel(root, {
    fileId,
    commandId,
    client: {
      lookup: async () => row,
      abandon: async (f, c, d) => {
        calls++
        assert.equal(d, digest)
        return { ...row, state: 'abandoned_uncommitted' }
      },
    },
  })
  await tick()
  const b = root.querySelector('[data-action=abandon]'),
    check = root.querySelector('input')
  assert.equal(b.disabled, true)
  b.click()
  await tick()
  assert.equal(calls, 0)
  check.checked = true
  check.dispatchEvent(new dom.window.Event('change'))
  b.click()
  await tick()
  assert.equal(calls, 1)
  assert.match(root.textContent, /不等于撤销/)
  assert.match(root.textContent, /禁止该命令后续保存/)
  assert.equal(b.disabled, true)
  panel.dispose()
})
test('lost mutation response disables repeated abandon until a fresh lookup', async () => {
  const dom = new JSDOM('<main></main>'),
    root = dom.window.document.querySelector('main')
  let calls = 0
  mod.mountCommandRecoveryPanel(root, {
    fileId,
    commandId,
    client: {
      lookup: async () => row,
      abandon: async () => {
        calls++
        throw Error('lost')
      },
    },
  })
  await tick()
  const check = root.querySelector('input'),
    b = root.querySelector('[data-action=abandon]')
  check.checked = true
  check.dispatchEvent(new dom.window.Event('change'))
  b.click()
  await tick()
  assert.equal(calls, 1)
  assert.equal(b.disabled, true)
  assert.match(root.textContent, /结果未确认/)
  assert.equal(root.querySelector('[data-action=lookup]').disabled, false)
})
test('dispose fences a late lookup from updating UI', async () => {
  const dom = new JSDOM('<main></main>'),
    root = dom.window.document.querySelector('main')
  let resolve
  const p = new Promise((r) => (resolve = r))
  const panel = mod.mountCommandRecoveryPanel(root, {
    fileId,
    commandId,
    client: { lookup: () => p, abandon: async () => row },
  })
  panel.dispose()
  resolve(row)
  await tick()
  assert.equal(root.textContent, '')
})
test('BFCache return creates fresh client and read-only panel after pagehide', async () => {
  const dom = new JSDOM('<main></main>'),
    root = dom.window.document.querySelector('main')
  let clients = 0,
    reads = 0,
    disposed = 0
  assert.equal(typeof mod.installCommandRecoveryPage, 'function')
  const page = mod.installCommandRecoveryPage(root, {
    fileId,
    commandId,
    createClient: () => {
      clients++
      return {
        lookup: async () => {
          reads++
          return row
        },
        abandon: async () => {
          throw Error('must not run')
        },
        dispose() {
          disposed++
        },
      }
    },
  })
  await tick()
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pagehide', { persisted: true }))
  assert.equal(root.textContent, '')
  assert.equal(disposed, 1)
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }))
  await tick()
  assert.equal(clients, 2)
  assert.equal(reads, 2)
  assert.match(root.textContent, /未确认持久保存/)
  page.dispose()
})
test('stop waiting invalidates late abandon reply and requires only a new lookup', async () => {
  const dom = new JSDOM('<main></main>'),
    root = dom.window.document.querySelector('main')
  let resolve,
    stops = 0
  const pending = new Promise((r) => (resolve = r))
  mod.mountCommandRecoveryPanel(root, {
    fileId,
    commandId,
    client: {
      lookup: async () => row,
      abandon: () => pending,
      cancelPending() {
        stops++
      },
    },
  })
  await tick()
  const check = root.querySelector('input')
  check.checked = true
  check.dispatchEvent(new dom.window.Event('change'))
  root.querySelector('[data-action=abandon]').click()
  root.querySelector('[data-action=stop]').click()
  assert.match(root.textContent, /没有撤回/)
  assert.equal(stops, 1)
  resolve({ ...row, state: 'abandoned_uncommitted' })
  await tick()
  assert.match(root.textContent, /没有撤回/)
  assert.equal(root.querySelector('[data-action=abandon]').disabled, true)
})
test('client disposal while response bytes are pending rejects late success', async () => {
  let send
  const stream = new ReadableStream({
    start(c) {
      send = () => {
        c.enqueue(new TextEncoder().encode(JSON.stringify(row)))
        c.close()
      }
    },
  })
  const c = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43),
    fetchImpl: async () =>
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
  })
  const p = c.lookup(fileId, commandId)
  await tick()
  c.dispose()
  send()
  await assert.rejects(p, /stopped/)
})
test('client rejects oversized response and an abandonment response still pending', async () => {
  for (const value of ['x'.repeat(9000), JSON.stringify(row)]) {
    const c = mod.createHttpCommandRecoveryClient({
      getCsrfToken: async () => 'c'.repeat(43),
      fetchImpl: async () =>
        new Response(value, { headers: { 'content-type': 'application/json' } }),
    })
    await assert.rejects(c.abandon(fileId, commandId, digest))
  }
})

test('lookup and mutation fetch refuse redirects and cross-origin mode', async () => {
  const calls = []
  const client = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43),
    fetchImpl: async (url, options) => {
      calls.push(options)
      return Response.json({
        ...row,
        state: url.endsWith('abandon') ? 'abandoned_uncommitted' : row.state,
      })
    },
  })
  await client.lookup(fileId, commandId)
  await client.abandon(fileId, commandId, digest)
  for (const options of calls) {
    assert.equal(options.mode, 'same-origin')
    assert.equal(options.referrerPolicy, 'same-origin')
    assert.equal(options.redirect, 'error')
  }
})
test('invalid CSRF token never reaches fetch', async () => {
  for (const token of ['', 'csrf', 'a'.repeat(44), ' '.repeat(43), 42, null]) {
    let calls = 0
    const client = mod.createHttpCommandRecoveryClient({
      getCsrfToken: async () => token,
      fetchImpl: async () => {
        calls++
        return Response.json(row)
      },
    })
    await assert.rejects(client.lookup(fileId, commandId))
    assert.equal(calls, 0)
  }
})
test('malformed UTF-8 response fails during decoding before JSON validation', async () => {
  const head = new TextEncoder().encode(
    JSON.stringify(row).replace('applied_uncommitted', 'applied_uncommitted'),
  )
  const bytes = new Uint8Array([...head.slice(0, -1), 44, 34, 120, 34, 58, 34, 255, 34, 125])
  const client = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43),
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }),
  })
  await assert.rejects(client.lookup(fileId, commandId), /encoded data|encoding|UTF-8/i)
})

test('standalone CSRF bootstrap also refuses redirects and cross-origin mode', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(
    new URL('../../tools/build-command-recovery-ui.mjs', import.meta.url),
    'utf8',
  )
  assert.match(source, /fetch\('\/api\/v1\/auth\/csrf',\{mode:'same-origin',redirect:'error'/)
})

test('cancel settles stalled CSRF and fences its late token without sending', async () => {
  let token, calls = 0
  const client = mod.createHttpCommandRecoveryClient({
    getCsrfToken: () => new Promise(r => { token = r }),
    fetchImpl: async () => { calls++; return Response.json(row) },
  })
  const pending = client.lookup(fileId, commandId)
  const outcome = pending.then(() => 'success', () => 'stopped')
  client.cancelPending()
  await tick()
  assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'stopped')
  token('c'.repeat(43))
  await tick()
  assert.equal(calls, 0)
})

test('dispose settles stalled response read even if stream cancellation never settles', async () => {
  let cancelled = 0
  const client = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43),
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled++; return new Promise(() => {}) },
    }), { headers: { 'content-type': 'application/json' } }),
  })
  const pending = client.lookup(fileId, commandId)
  const outcome = pending.then(() => 'success', () => 'stopped')
  await tick()
  client.dispose()
  await tick()
  assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'stopped')
  assert.equal(cancelled, 1)
})

test('cancel settles stalled mutation fetch and cancels late body without replay', async () => {
  let reply, calls = 0, cancelled = 0
  const client = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43),
    fetchImpl: () => { calls++; return new Promise(r => { reply = r }) },
  })
  const pending = client.abandon(fileId, commandId, digest)
  const outcome = pending.then(() => 'success', () => 'stopped')
  await tick()
  client.cancelPending()
  await tick()
  assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'stopped')
  reply(new Response(new ReadableStream({ cancel() { cancelled++ } }), {
    headers: { 'content-type': 'application/json' },
  }))
  await tick()
  assert.equal(calls, 1)
  assert.equal(cancelled, 1)
})

test('cancellation between response arrival and await continuation releases body', async () => {
  let reply, cancelled = 0
  const raw = new Promise(r => { reply = r })
  const client = mod.createHttpCommandRecoveryClient({
    getCsrfToken: async () => 'c'.repeat(43), fetchImpl: () => raw,
  })
  const pending = client.lookup(fileId, commandId)
  await tick()
  raw.then(() => client.cancelPending())
  reply(new Response(new ReadableStream({ cancel() { cancelled++ } }), {
    headers: { 'content-type': 'application/json' },
  }))
  await assert.rejects(pending, /stopped/)
  assert.equal(cancelled, 1)
})
