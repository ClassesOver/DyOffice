import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { request } from 'node:http'
import Fastify from 'fastify'
import { objectTransferAdmission } from '../server/src/modules/files/transfer-admission.ts'

const pair = () => ({
  request: { raw: Object.assign(new EventEmitter(), { aborted: false }) },
  reply: { raw: Object.assign(new EventEmitter(), { destroyed: false }) },
})
function occupied() {
  const budget = objectTransferAdmission({})
  const active = [pair(), pair()]
  for (const p of active) budget.admit(p.request, p.reply)
  return { budget, active }
}

test('queued save timeout removes its waiter without taking a transfer slot', async () => {
  const { budget, active } = occupied(), queued = pair()
  await assert.rejects(budget.admit(queued.request, queued.reply, { waitMs: 20 }), { statusCode: 503, retryAfter: 1 })
  assert.equal(queued.request.raw.listenerCount('aborted'), 0)
  assert.equal(queued.reply.raw.listenerCount('close'), 0)
  for (const p of active) budget.close(p.request)
  const next = [pair(), pair()]
  for (const p of next) budget.admit(p.request, p.reply)
  for (const p of next) budget.close(p.request)
})

test('queued saves inherit capacity FIFO and cannot be overtaken by a fresh read', async () => {
  const { budget, active } = occupied(), queue = [pair(), pair(), pair()], order = []
  const waits = queue.map((p, i) => budget.admit(p.request, p.reply, { waitMs: 1000 }).then(() => order.push(i)))
  budget.close(active[0].request)
  await waits[0]
  assert.deepEqual(order, [0])
  const fresh = pair()
  assert.throws(() => budget.admit(fresh.request, fresh.reply), { statusCode: 503 })
  budget.close(queue[0].request); await waits[1]
  assert.deepEqual(order, [0, 1])
  budget.close(queue[1].request); await waits[2]
  assert.deepEqual(order, [0, 1, 2])
  budget.close(queue[2].request); budget.close(active[1].request)
})

for (const event of ['aborted', 'response-close']) test(`queued save ${event} settles promptly and does not consume future capacity`, async () => {
  const { budget, active } = occupied(), queued = pair()
  const waiting = budget.admit(queued.request, queued.reply, { waitMs: 1000 })
  const rejected = assert.rejects(waiting, { statusCode: 400 })
  if (event === 'aborted') { queued.request.raw.aborted = true; queued.request.raw.emit('aborted') }
  else { queued.reply.raw.destroyed = true; queued.reply.raw.emit('close') }
  for (const p of active) budget.close(p.request)
  await rejected
  assert.equal(queued.request.raw.listenerCount('aborted'), 0)
  assert.equal(queued.reply.raw.listenerCount('close'), 0)
  const next = [pair(), pair()]
  for (const p of next) budget.admit(p.request, p.reply)
  for (const p of next) budget.close(p.request)
})

test('real HTTP queued JSON save disconnect frees its queue position', { timeout: 5000 }, async () => {
  const app = Fastify(), budget = objectTransferAdmission(app)
  let release, entered, queued, disconnected
  const gate = new Promise(r => { release = r }), ready = new Promise(r => { entered = r })
  const queuedReady = new Promise(r => { queued = r })
  const serverDisconnected = new Promise(r => { disconnected = r })
  let reads = 0, saves = 0
  app.addHook('onRequest', async (q, p) => {
    const admission = budget.admit(q, p, q.url === '/save' ? { waitMs: 1000 } : undefined)
    if (q.url === '/save') {
      q.raw.once('aborted', disconnected)
      queued()
    }
    await admission
  })
  app.addHook('onResponse', async q => budget.close(q))
  app.addHook('onError', async q => budget.error(q))
  app.get('/read', async (q, p) => budget.transfer(q, p, async () => {
    if (++reads === 2) entered()
    await gate
    return 'read'
  }))
  app.post('/save', async (q, p) => budget.transfer(q, p, async () => { saves++; return 'saved' }))
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  const active = [app.inject('/read'), app.inject('/read')]
  let client
  try {
    await ready
    client = request(`${origin}/save`, { method: 'POST', headers: { 'content-type': 'application/json' } })
    client.on('error', () => {})
    client.end('{}')
    await queuedReady
    const closed = once(client, 'close')
    client.destroy(); await closed.catch(() => {})
    await serverDisconnected
    release(); await Promise.all(active)
    assert.equal(saves, 0)
    const responses = await Promise.all([app.inject('/read'), app.inject('/read')])
    assert.deepEqual(responses.map(r => r.statusCode), [200, 200])
  } finally { release(); client?.destroy(); await Promise.all(active); await app.close() }
})
