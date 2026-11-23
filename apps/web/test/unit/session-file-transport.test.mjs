import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createSessionFileHost } from '../../../../packages/browser-host/src/session-files.ts'
const json = (x, status = 200) => Response.json(x, { status })
const capabilities = { docx: 'editable', xlsx: 'editable', pptx: 'read_only', pdf: 'read_only' }
function fixture(t, intercept = () => undefined, expectedRevision) {
  const fileId = randomUUID(),
    editorId = randomUUID(),
    uploadId = randomUUID(),
    bytes = new Uint8Array([1, 2, 3]),
    ref = {
      fileId,
      revision: randomUUID(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: 3,
    },
    calls = []
  const host = createSessionFileHost({
    editorId,
    expectedRevision: expectedRevision?.(ref),
    fetchImpl: async (path, init = {}) => {
      calls.push({ path, init })
      const hit = await intercept(path, init)
      if (hit) return hit
      if (path.endsWith('/csrf')) return json({ csrfToken: 'a'.repeat(43) })
      if (path.endsWith('/capabilities')) return json(capabilities)
      if (path === `/api/v1/files/${fileId}`)
        return json({
          file: ref,
          format: 'docx',
          name: 'a.docx',
          capabilities,
          downloadEndpoint: `/api/v1/files/${fileId}/content?revision=${ref.revision}`,
        })
      if (path.includes('/content?'))
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
      if (path.endsWith('/lease') && init.method === 'DELETE')
        return new Response(null, { status: 204 })
      if (path.includes('/lease'))
        return json({
          editorId,
          leaseEpoch: 1,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })
      if (path.endsWith('/uploads')) return json({ uploadId })
      if (path.endsWith('/content') && init.method === 'PUT')
        return new Response(null, { status: 204 })
      if (path.endsWith('/commits')) return json({ ...ref, revision: randomUUID() })
      throw Error('Unexpected ' + path)
    },
  })
  t.after(() => host.dispose())
  return { host, fileId, ref, bytes, calls }
}
test('an editor opened from a citation rejects a newer head before reading or editing it', async (t) => {
  const f = fixture(t, undefined, () => randomUUID())
  await assert.rejects(f.host.open(f.fileId), {code:'CONFLICT',message:/cited revision/})
  assert.deepEqual(f.calls.map(({path})=>path), [`/api/v1/files/${f.fileId}`])
  const current = fixture(t, undefined, ref=>ref.revision)
  assert.deepEqual((await current.host.open(current.fileId)).file, current.ref)
  current.ref.revision = randomUUID()
  assert.deepEqual((await current.host.open(current.fileId)).file, current.ref)
})
test('all session requests fix origin, forbid redirects, including CSRF bytes PUT commit and keepalive', async (t) => {
  const f = fixture(t)
  await f.host.getCapabilities()
  await f.host.open(f.fileId)
  await f.host.readBytes(f.fileId, f.ref.revision)
  await f.host.acquireLease(f.fileId)
  await f.host.save(f.fileId, f.bytes)
  await f.host.releaseLease(f.fileId, true)
  for (const { path, init } of f.calls) {
    assert.match(path, /^\/api\//)
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.referrerPolicy, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.cache, 'no-store')
  }
  assert.ok(f.calls.some((c) => c.init.method === 'PUT'))
  assert.ok(f.calls.some((c) => c.init.keepalive === true))
})
test('redirected JSON fails closed', async (t) => {
  const f = fixture(t, (path) => {
    if (path.endsWith('/capabilities')) {
      const r = json(capabilities)
      Object.defineProperty(r, 'redirected', { value: true })
      return r
    }
  })
  await assert.rejects(f.host.getCapabilities())
})
test('JSON streaming bound cancels oversized body before full read', async (t) => {
  let pulls = 0,
    cancelled = false
  const chunk = new TextEncoder().encode('界'.repeat(100000))
  const f = fixture(t, (path) =>
    path.endsWith('/capabilities')
      ? new Response(
          new ReadableStream({
            pull(c) {
              pulls++
              if (pulls < 8) c.enqueue(chunk)
              else c.close()
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      : undefined,
  )
  await assert.rejects(f.host.getCapabilities())
  assert.equal(cancelled, true)
  assert.ok(pulls <= 5)
})
test('dispose during pending JSON cancels body and cannot create a late context', async (t) => {
  let entered,
    cancelled = false
  const ready = new Promise((r) => (entered = r))
  const f = fixture(t, (path) =>
    path.includes('/files/')
      ? new Response(
          new ReadableStream({
            pull() {
              entered()
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      : undefined,
  )
  const opened = f.host.open(f.fileId)
  await ready
  f.host.dispose()
  await assert.rejects(
    Promise.race([
      opened,
      new Promise((_, rej) => setTimeout(() => rej(Error('test timeout')), 300)),
    ]),
    (e) => e.message !== 'test timeout',
  )
  assert.equal(cancelled, true)
  assert.throws(() => f.host.getState(f.fileId))
})
test('dispose during byte read rejects late bytes without changing integrity checks', async (t) => {
  let entered,
    cancelled = false
  const ready = new Promise((r) => (entered = r))
  const f = fixture(t, (path) =>
    path.includes('/content?')
      ? new Response(
          new ReadableStream({
            pull() {
              entered()
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { 'content-type': 'application/octet-stream' } },
        )
      : undefined,
  )
  await f.host.open(f.fileId)
  const read = f.host.readBytes(f.fileId, f.ref.revision)
  await ready
  f.host.dispose()
  await assert.rejects(
    Promise.race([
      read,
      new Promise((_, rej) => setTimeout(() => rej(Error('test timeout')), 300)),
    ]),
    (e) => e.message !== 'test timeout',
  )
  assert.equal(cancelled, true)
})
test('403 proof refresh retries once, network and 5xx never retry', async (t) => {
  let csrf = 0,
    posts = 0
  const f = fixture(t, (path, init) => {
    if (path.endsWith('/csrf')) {
      csrf++
      return json({ csrfToken: 'a'.repeat(43) })
    }
    if (path.endsWith('/lease') && init.method === 'POST') {
      posts++
      if (posts === 1) return json({}, 403)
    }
  })
  await f.host.open(f.fileId)
  await f.host.acquireLease(f.fileId)
  assert.equal(posts, 2)
  assert.equal(csrf, 2)
  for (const mode of ['network', 'server']) {
    let tries = 0
    const g = fixture(t, (path, init) => {
      if (path.endsWith('/lease') && init.method === 'POST') {
        tries++
        if (mode === 'network') throw TypeError('lost')
        return json({}, 500)
      }
    })
    await g.host.open(g.fileId)
    await assert.rejects(g.host.acquireLease(g.fileId))
    assert.equal(tries, 1)
  }
})
test('strict JSON MIME and UTF8 reject invalid responses', async (t) => {
  for (const mode of ['mime', 'utf8']) {
    const f = fixture(t, (path) =>
      path.endsWith('/capabilities')
        ? new Response(mode === 'utf8' ? new Uint8Array([0xff]) : JSON.stringify(capabilities), {
            headers: {
              'content-type':
                mode === 'mime' ? 'text/application/json-malicious' : 'application/json',
            },
          })
        : undefined,
    )
    await assert.rejects(f.host.getCapabilities())
  }
})
test('ordinary metadata below 1MiB and split UTF8 remain compatible', async (t) => {
  const payload = JSON.stringify({ ...capabilities, note: '界'.repeat(250000) }),
    encoded = new TextEncoder().encode(payload)
  const f = fixture(t, (path) => {
    if (!path.endsWith('/capabilities')) return
    let offset = 0
    return new Response(
      new ReadableStream({
        pull(c) {
          if (offset === encoded.length) {
            c.close()
            return
          }
          const end = Math.min(encoded.length, offset + 997)
          c.enqueue(encoded.slice(offset, end))
          offset = end
        },
      }),
      { headers: { 'content-type': 'application/json; charset=utf-8' } },
    )
  })
  assert.deepEqual(await f.host.getCapabilities(), capabilities)
})
test('keepalive release remains sent after disposal but an error is not reported as success', async (t) => {
  let complete, entered, signal
  const ready = new Promise((r) => (entered = r))
  const f = fixture(t, (path, init) => {
    if (path.endsWith('/lease') && init.method === 'DELETE') {
      signal = init.signal
      entered()
      return new Promise((r) => (complete = r))
    }
  })
  await f.host.open(f.fileId)
  await f.host.acquireLease(f.fileId)
  const releasing = f.host.releaseLease(f.fileId, true)
  await ready
  f.host.dispose()
  assert.equal(signal.aborted, false)
  complete(json({}, 500))
  await assert.rejects(releasing, { code: 'UNAVAILABLE' })
})
test('dispose aborts pending headers and late commit cannot resolve successfully', async (t) => {
  let complete, entered
  const ready = new Promise((r) => (entered = r))
  const f = fixture(t, (path) =>
    path.endsWith('/commits') ? (entered(), new Promise((r) => (complete = r))) : undefined,
  )
  await f.host.open(f.fileId)
  await f.host.acquireLease(f.fileId)
  const saving = f.host.save(f.fileId, f.bytes)
  await ready
  f.host.dispose()
  complete(json({ ...f.ref, revision: randomUUID() }))
  await assert.rejects(saving, { code: 'UNAVAILABLE' })
  assert.equal(f.calls.filter((c) => c.path.endsWith('/commits')).length, 1)
  assert.equal(f.calls.find((c) => c.path.endsWith('/commits')).init.signal.aborted, true)
})
test('403 auth refresh never loops beyond one retry', async (t) => {
  let attempts = 0
  const f = fixture(t, (path, init) =>
    path.endsWith('/lease') && init.method === 'POST' ? (attempts++, json({}, 403)) : undefined,
  )
  await f.host.open(f.fileId)
  await assert.rejects(f.host.acquireLease(f.fileId), { code: 'UNAUTHORIZED' })
  assert.equal(attempts, 2)
})
test('dispose in the JSON-to-caller microtask gap cannot reopen context or accept commit', async (t) => {
  for (const action of ['open', 'commit']) {
    const f = fixture(t)
    if (action === 'commit') {
      await f.host.open(f.fileId)
      await f.host.acquireLease(f.fileId)
    }
    const original = JSON.parse
    JSON.parse = (text, ...rest) => {
      const value = original(text, ...rest)
      if (action === 'open' ? !!value.file : !!value.revision)
        queueMicrotask(() => f.host.dispose())
      return value
    }
    try {
      await assert.rejects(
        action === 'open' ? f.host.open(f.fileId) : f.host.save(f.fileId, f.bytes),
        { code: 'UNAVAILABLE' },
      )
      assert.throws(() => f.host.getState(f.fileId))
    } finally {
      JSON.parse = original
      f.host.dispose()
    }
  }
})


test('guard revoked during DOCX byte upload prevents commit submission',async t=>{
 let authorized=true
 const f=fixture(t,(path,init)=>{if(path.endsWith('/content')&&init.method==='PUT')authorized=false})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 await assert.rejects(f.host.save(f.fileId,f.bytes,()=>authorized))
 assert.equal(f.calls.filter(call=>call.path.endsWith('/commits')).length,0)
})
test('trusted guard is checked after saving-state listeners before the commit fetch',async t=>{
 let authorized=true
 const f=fixture(t)
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 f.host.subscribe(()=>{if(f.host.getState(f.fileId).status==='saving')authorized=false})
 await assert.rejects(f.host.save(f.fileId,f.bytes,()=>authorized))
 assert.equal(f.calls.filter(call=>call.path.endsWith('/commits')).length,0)
})
test('revocation after a refused commit prevents CSRF retry from submitting it again',async t=>{
 let authorized=true
 const f=fixture(t,path=>{if(path.endsWith('/commits')){authorized=false;return json({},403)}})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 await assert.rejects(f.host.save(f.fileId,f.bytes,()=>authorized))
 assert.equal(f.calls.filter(call=>call.path.endsWith('/commits')).length,1)
})
test('blocking a recovery preserves a genuinely submitted unknown receipt',async t=>{
 let lose=true
 const f=fixture(t,path=>{if(path.endsWith('/commits')&&lose){lose=false;throw new TypeError('lost response')}})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 await assert.rejects(f.host.save(f.fileId,f.bytes))
 assert.equal(f.host.getState(f.fileId).status,'unknown')
 await assert.rejects(f.host.reconcile(f.fileId,()=>false))
 assert.equal(f.host.getState(f.fileId).status,'unknown')
 assert.equal(f.calls.filter(call=>call.path.endsWith('/commits')).length,1)
 await f.host.reconcile(f.fileId,()=>true)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/commits')).length,2)
 assert.equal(f.host.getState(f.fileId).status,'idle')
})
test('a genuine unknown keeps its originating fence across default reconcile and next save',async t=>{
 let allowed=true,lose=true
 const f=fixture(t,path=>{if(path.endsWith('/commits')&&lose){lose=false;throw new TypeError('lost response')}})
 await f.host.open(f.fileId);await f.host.acquireLease(f.fileId)
 await assert.rejects(f.host.save(f.fileId,f.bytes,()=>allowed))
 allowed=false
 await assert.rejects(f.host.reconcile(f.fileId))
 await assert.rejects(f.host.save(f.fileId,f.bytes))
 assert.equal(f.calls.filter(call=>call.path.endsWith('/commits')).length,1)
 assert.equal(f.host.getState(f.fileId).status,'unknown')
 allowed=true
 await f.host.reconcile(f.fileId)
 assert.equal(f.calls.filter(call=>call.path.endsWith('/commits')).length,2)
})

test('an in-flight commit cannot be reconciled concurrently and erase a later save', async t => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  let attempts = 0
  const f = fixture(t, async path => {
    if (!path.endsWith('/commits')) return
    attempts++
    if (attempts === 1) { entered(); await held }
    return json({ ...f.ref, revision: committed })
  })
  const committed = randomUUID()
  await f.host.open(f.fileId); await f.host.acquireLease(f.fileId)
  const saving = f.host.save(f.fileId, f.bytes)
  await started
  try {
    await assert.rejects(f.host.reconcile(f.fileId), { code: 'UNAVAILABLE' })
    assert.equal(attempts, 1)
    assert.equal(f.host.getState(f.fileId).status, 'saving')
  } finally { release(); await saving }
  assert.equal(f.host.getState(f.fileId).revision.revision, committed)
  assert.equal(f.host.getState(f.fileId).status, 'idle')
})
