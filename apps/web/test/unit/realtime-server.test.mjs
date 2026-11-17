import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRealtimeRegistry, REALTIME_MAX_PENDING_BYTES } from '../../server/src/modules/realtime/sessions.ts'
import { createRealtimeDispatcher } from '../../server/src/modules/realtime/dispatch.ts'
import { isCurrentEditor } from '../../server/src/modules/realtime/state.ts'
import { decodeRealtimeClientMessage, decodeRealtimeServerMessage, REALTIME_MAX_MESSAGE_BYTES } from '../../../../packages/web-contracts/src/realtime.ts'

class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent = []
  callbacks = []
  terminated = false
  send(text, callback) { this.sent.push(JSON.parse(text)); this.callbacks.push(callback) }
  ping() {}
  close() { this.terminate() }
  terminate() { if (this.terminated) return; this.terminated = true; this.readyState = 3; this.emit('close', 1006) }
}
const identity = (userId = randomUUID()) => ({ deploymentId: '00000000-0000-0000-0000-000000000001', userId, sessionId: randomUUID(), fileId: randomUUID(), editorId: randomUUID(), token: 't'.repeat(43) })
const snapshot = () => ({ headRevision: randomUUID(), lease: { leaseEpoch: 0, editorId: null, expiresAt: null, active: false, heldByCurrentSession: false } })
function fixture(t) {
  const registry = createRealtimeRegistry({ heartbeatIntervalMs: 60_000 })
  t.after(() => registry.close())
  const id = identity(), socket = new Socket(), reservation = registry.reserve(id)
  const connection = registry.registerEditor(id, socket, reservation)
  return { registry, connection, socket }
}

test('realtime client decoder permits only ping/sync and bounded UUID reconcile', () => {
  for (const type of ['ping', 'sync']) assert.deepEqual(decodeRealtimeClientMessage(JSON.stringify({ type })), { type })
  const request = { type: 'reconcile', requestId: randomUUID(), commandIds: Array.from({ length: 16 }, randomUUID) }
  assert.deepEqual(decodeRealtimeClientMessage(JSON.stringify(request)), request)
  assert.equal(decodeRealtimeClientMessage(JSON.stringify({ ...request, commandIds: [...request.commandIds, randomUUID()] })), undefined)
  for (const bad of [
    { type: 'file-event', fileEvent: snapshot() }, { type: 'editor-command', payload: { write: true } }, { type: 'ping', payload: {} },
    { ...request, requestId: 'bad' }, { ...request, commandIds: [request.commandIds[0], request.commandIds[0].toUpperCase()] },
    { ...request, commandIds: ['bad'] }, { ...request, extra: true },
  ]) assert.equal(decodeRealtimeClientMessage(JSON.stringify(bad)), undefined)
  assert.equal(decodeRealtimeClientMessage('x'.repeat(REALTIME_MAX_MESSAGE_BYTES + 1)), undefined)
})

test('realtime server decoder rejects fabricated numeric heads, invalid sequences and unknown data', () => {
  const state = { type: 'state', ...snapshot(), generation: 1 }
  assert.deepEqual(decodeRealtimeServerMessage(JSON.stringify(state)), state)
  const event = { type: 'file-event', fileEvent: { ...snapshot(), generation: 2 } }
  assert.deepEqual(decodeRealtimeServerMessage(JSON.stringify(event)), event)
  for (const invalid of [
    { ...state, headRevision: 2 }, { ...state, generation: 0 }, { ...state, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...state, extra: true }, { ...state, lease: { ...state.lease, editorId: 'bad' } }, { ...state, lease: { ...state.lease, extra: 1 } },
    { type: 'editor-command', payload: {} },
  ]) assert.equal(decodeRealtimeServerMessage(JSON.stringify(invalid)), undefined)
  for (const value of ['pending_approval', 'approved', 'unknown_outcome', 'applied_uncommitted', 'committed', 'cancelled', 'abandoned_uncommitted', null]) {
    const response = { type: 'command-state', requestId: randomUUID(), commands: [{ commandId: randomUUID(), state: value }] }
    assert.deepEqual(decodeRealtimeServerMessage(JSON.stringify(response)), response)
  }
})

test('channel notifications reuse the editor connection and failure leaves file notifications working',async t=>{
 const f=fixture(t),head=snapshot(),conversationId=randomUUID()
 let fail=false
 const dispatcher=createRealtimeDispatcher({registry:f.registry,state:{async withSnapshot(connection,effect){await effect(head,[])}},async channelNotifications(token,fileId){assert.equal(token,f.connection.token);assert.equal(fileId,f.connection.fileId);if(fail)throw Error('peer service unavailable');return [{conversationId,sequence:2}]}})
 await dispatcher.initialize(f.connection)
 await dispatcher.poll(f.connection);await dispatcher.poll(f.connection)
 assert.equal(f.socket.sent.filter(message=>message.type==='assistant-channels').length,1)
 assert.deepEqual(decodeRealtimeServerMessage(JSON.stringify(f.socket.sent.at(-1))),{type:'assistant-channels',channels:[{conversationId,sequence:2}]})
 assert.equal(decodeRealtimeServerMessage(JSON.stringify({type:'assistant-channels',channels:[{conversationId,sequence:-1}]})),undefined)
 fail=true
 assert.equal((await dispatcher.poll(f.connection)).status,'ok')
 assert.equal(f.socket.terminated,false)
})

test('registry admits exactly 64 total and at most 8 per owner, with idempotent release', t => {
  const registry = createRealtimeRegistry(); t.after(() => registry.close())
  const reservations = [], users = Array.from({ length: 8 }, randomUUID)
  for (const user of users) for (let i = 0; i < 8; i++) { const r = registry.reserve(identity(user)); assert.ok(r); reservations.push(r) }
  assert.equal(registry.reserved, 64)
  assert.equal(registry.reserve(identity()), undefined)
  assert.equal(registry.reserve(identity(users[0])), undefined)
  reservations[0].release(); reservations[0].release()
  assert.equal(registry.reserved, 63)
  const replacement = registry.reserve(identity(users[0])); assert.ok(replacement)
  assert.equal(registry.reserve(identity(users[0])), undefined)
})

test('outbound pending frame count and buffered bytes terminate a slow socket', t => {
  const first = fixture(t)
  for (let i = 0; i < 64; i++) assert.equal(first.registry.send(first.connection, { type: 'pong' }), true)
  assert.equal(first.registry.send(first.connection, { type: 'pong' }), false)
  assert.equal(first.socket.terminated, true)
  assert.equal(first.connection.pendingMessages, 64)
  for (const callback of first.socket.callbacks) callback()
  assert.equal(first.connection.pendingMessages, 0)
  const second = fixture(t)
  second.socket.bufferedAmount = REALTIME_MAX_PENDING_BYTES
  assert.equal(second.registry.send(second.connection, { type: 'pong' }), false)
  assert.equal(second.socket.terminated, true)
})

test('inbound receipt caps admission at sixteen operations and 128KiB before async authorization', async t => {
  const f = fixture(t)
  let release, executed = 0
  const gate = new Promise(resolve => { release = resolve })
  f.connection.chain = gate
  for (let i = 0; i < 16; i++) assert.equal(f.registry.enqueue(f.connection, 1, async () => { executed++ }), true)
  assert.equal(f.registry.enqueue(f.connection, 1, async () => { executed++ }), false)
  assert.equal(f.connection.inboundMessages, 16)
  release(); await f.registry.drain()
  assert.equal(executed, 0)
  assert.equal(f.connection.inboundMessages, 0)
  const bytes = fixture(t)
  bytes.connection.chain = new Promise(resolve => { release = resolve })
  for (let i = 0; i < 8; i++) assert.equal(bytes.registry.enqueue(bytes.connection, 16 * 1024, async () => {}), true)
  assert.equal(bytes.registry.enqueue(bytes.connection, 1, async () => {}), false)
  assert.equal(bytes.connection.inboundBytes, 128 * 1024)
  release(); await bytes.registry.drain()
})

test('generation orders only this connection snapshots and never compares revision UUIDs', t => {
  const f = fixture(t), newer = snapshot(), arbitrary = snapshot()
  assert.equal(f.registry.sendSnapshot(f.connection, newer, 'state'), true)
  assert.equal(f.registry.sendSnapshot(f.connection, arbitrary, 'file-event'), true)
  assert.deepEqual(f.socket.sent.map(m => m.generation ?? m.fileEvent.generation), [1, 2])
  assert.equal(f.socket.sent[1].fileEvent.headRevision, arbitrary.headRevision)
  const fresh = f.registry.registerEditor(f.connection, new Socket(), f.registry.reserve(f.connection))
  f.registry.sendSnapshot(fresh, arbitrary, 'state')
  assert.equal(fresh.generation, 1)
})

test('lease authority requires active, same session and exact bound editor; null is never a writer', () => {
  const editorId = randomUUID(), lease = { leaseEpoch: 1, editorId, active: true, heldByCurrentSession: true, expiresAt: new Date().toISOString() }
  assert.equal(isCurrentEditor({ editorId }, lease), true)
  for (const [id, value] of [[null, lease], [randomUUID(), lease], [editorId, { ...lease, active: false }], [editorId, { ...lease, heldByCurrentSession: false }]]) assert.equal(isCurrentEditor({ editorId: id }, value), false)
})

test('trusted server dispatch is explicitly unsupported and never echoes or invokes a writer', async t => {
  const f = fixture(t)
  const dispatcher = createRealtimeDispatcher({ registry: f.registry, state: { withSnapshot: () => { throw new Error('unexpected writer/read') } } })
  assert.deepEqual(await dispatcher.dispatchToEditor({ commandId: randomUUID(), connectionId: f.connection.connectionId, editorId: f.connection.editorId,
    generation: 1, epoch: f.connection.epoch, leaseEpoch: 1 }), { status: 'unsupported' })
  assert.deepEqual(f.socket.sent, [])
})

test('poll always independently authorizes each connection and never sends cached data after revocation', async t => {
  const f = fixture(t)
  f.registry.sendSnapshot(f.connection, snapshot(), 'state')
  const dispatcher = createRealtimeDispatcher({ registry: f.registry, state: { withSnapshot: async () => { throw Object.assign(new Error('revoked'), { statusCode: 401 }) } } })
  assert.deepEqual(await dispatcher.poll(f.connection), { status: 'unauthorized' })
  assert.deepEqual(f.socket.sent.map(m => m.type), ['state', 'error'])
  assert.equal(f.socket.terminated, true)
})
