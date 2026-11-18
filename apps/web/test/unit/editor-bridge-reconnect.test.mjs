import test from 'node:test'
import assert from 'node:assert/strict'
import { createEditorBridge } from '../../../../packages/browser-host/src/editor-bridge.ts'

const fileId = '11111111-1111-4111-8111-111111111111'
const editorId = '22222222-2222-4222-8222-222222222222'
const revision = '33333333-3333-4333-8333-333333333333'
const nextRevision = '44444444-4444-4444-8444-444444444444'
const commandId = '55555555-5555-4555-8555-555555555555'
const lease = { leaseEpoch: 1, editorId, expiresAt: '2027-01-01T00:00:00.000Z', active: true, heldByCurrentSession: true }
const waitFor = async predicate => {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition did not settle')
}
function fixture(overrides = {}) {
  const sockets = [], calls = [], events = [], reconciled = [], statuses = []
  class Socket {
    static OPEN = 1
    readyState = 0
    bufferedAmount = 0
    sent = []
    constructor(url) { this.url = url; sockets.push(this) }
    open() { this.readyState = 1; this.onopen?.({}) }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
    disconnect(code = 1006) { this.readyState = 3; this.onclose?.({ code }) }
  }
  let tickets = 0
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/csrf')) return Response.json({ csrfToken: 'c'.repeat(43) })
    tickets++
    return Response.json({ ticket: 'a'.repeat(42) + String(tickets) }, { status: 201 })
  }
  const bridge = createEditorBridge({ origin: 'https://office.example', fileId, editorId, fetchImpl, WebSocketImpl: Socket,
    initialBackoffMs: 5, maxBackoffMs: 20, heartbeatMs: 5000, random: () => 0.5,
    onEvent: event => events.push(event), onStatus: status => statuses.push(status),
    onReconcile: event => reconciled.push(event), ...overrides })
  return { bridge, sockets, calls, events, reconciled, statuses }
}

test('fresh connection binds editor identity, accepts UUID revisions and drops stale frames before callbacks', async t => {
  const f = fixture(); t.after(() => f.bridge.dispose())
  await waitFor(() => f.sockets.length === 1)
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { fileId, editorId })
  assert.equal(f.calls[1].init.referrerPolicy, 'same-origin')
  const s = f.sockets[0]; s.open()
  s.message({ type: 'state', generation: 1, headRevision: revision, lease })
  s.message({ type: 'file-event', fileEvent: { generation: 3, headRevision: nextRevision, lease } })
  s.message({ type: 'file-event', fileEvent: { generation: 2, headRevision: revision, lease } })
  assert.equal(f.bridge.getHeadRevision(), nextRevision)
  assert.equal(f.events.length, 2)
  assert.equal(f.bridge.getStatus(), 'open')
})

test('reconnect uses a fresh ticket and a fresh sequence, then reconciles pending command IDs without replaying writes', async t => {
  const f = fixture({ pendingCommandIds: () => [commandId] }); t.after(() => f.bridge.dispose())
  await waitFor(() => f.sockets.length === 1)
  const s = f.sockets[0]; s.open()
  s.message({ type: 'state', generation: 9, headRevision: revision, lease })
  await waitFor(() => s.sent.length)
  assert.equal(s.sent[0].type, 'reconcile')
  const staleListener = s.onmessage
  s.disconnect()
  await waitFor(() => f.sockets.length === 2)
  const next = f.sockets[1]; assert.notEqual(next.url, s.url); next.open()
  next.message({ type: 'state', generation: 1, headRevision: nextRevision, lease })
  staleListener?.({ data: JSON.stringify({ type: 'file-event', fileEvent: { generation: 99, headRevision: revision, lease } }) })
  assert.equal(f.bridge.getHeadRevision(), nextRevision)
  await waitFor(() => next.sent.length)
  const req = next.sent[0]
  next.message({ type: 'command-state', requestId: req.requestId, commands: [{ commandId, state: 'applied_uncommitted' }] })
  assert.equal(f.reconciled.length, 1)
  assert.deepEqual(f.reconciled[0].commands, [{ commandId, state: 'applied_uncommitted' }])
  assert.ok(f.sockets.every(socket => socket.sent.every(message => message.type === 'reconcile' || message.type === 'ping')))
})

test('disposal aborts an in-flight ticket request and never creates a late socket', async () => {
  let signal
  const f = fixture({ fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }) })
  await waitFor(() => signal)
  f.bridge.dispose()
  assert.equal(signal.aborted, true)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(f.sockets.length, 0)
  assert.equal(f.bridge.getStatus(), 'disposed')
})

test('revoked sessions and absent capability stop reconnect attempts', async t => {
  for (const [status, expected] of [[401, 'unauthorized'], [501, 'unavailable']]) {
    let calls = 0
    const f = fixture({ fetchImpl: async () => { calls++; return new Response('', { status }) } }); t.after(() => f.bridge.dispose())
    await waitFor(() => f.bridge.getStatus() === expected)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(calls, 1)
  }
})

test('throwing consumers cannot break ordering and a new server state never adopts a draft automatically', async t => {
  let count = 0
  const f = fixture({ onEvent: () => { count++; throw Error('consumer') } }); t.after(() => f.bridge.dispose())
  await waitFor(() => f.sockets.length)
  const s = f.sockets[0]; s.open()
  assert.doesNotThrow(() => s.message({ type: 'state', generation: 1, headRevision: revision, lease }))
  assert.doesNotThrow(() => s.message({ type: 'file-event', fileEvent: { generation: 2, headRevision: nextRevision, lease } }))
  assert.equal(count, 2)
  assert.equal(f.calls.some(call => /commits|uploads|content/.test(call.url)), false)
})


test('trusted command delivery requires exact registration fences and acknowledges acceptance only once', async t => {
 const connectionId='66666666-6666-4666-8666-666666666666', connectionEpoch='77777777-7777-4777-8777-777777777777'
 const deliveryId='88888888-8888-4888-8888-888888888888', claimId='99999999-9999-4999-8999-999999999999'
 const calls=[]
 const f=fixture({commandTarget:{registration:()=>({baseRevision:revision,editorGeneration:4,leaseEpoch:1,capabilities:['docx.append']}),onCommand:async(command)=>{calls.push(command);return true}}})
 t.after(()=>f.bridge.dispose())
 await waitFor(()=>f.sockets.length)
 const socket=f.sockets[0];socket.open();socket.message({type:'state',headRevision:revision,generation:1,lease})
 await waitFor(()=>socket.sent.some(m=>m.type==='register'))
 const request=socket.sent.find(m=>m.type==='register')
 socket.message({...request,type:'registered',connectionId,epoch:connectionEpoch})
 const command={type:'command',connectionId,epoch:connectionEpoch,editorId,deliveryId,claimId,digest:'d'.repeat(64),envelope:{commandId,fileId,baseRevision:revision,editorGeneration:4,leaseEpoch:1,argsHash:'a'.repeat(64),payload:{toolName:'docx.append',arguments:{text:'allowed'}}}}
 socket.message({...command,envelope:{...command.envelope,editorGeneration:3}})
 socket.message({...command,epoch:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})
 assert.equal(calls.length,0)
 socket.message(command)
 await waitFor(()=>socket.sent.some(m=>m.type==='ack'))
 socket.message(command)
 await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(calls.length,1)
 assert.deepEqual(socket.sent.filter(m=>m.type==='ack'),[{type:'ack',connectionId,epoch:connectionEpoch,deliveryId,commandId,claimId,status:'delivered'}])
 assert.equal(f.calls.some(call=>/commits|uploads/.test(call.url)),false)
})

test('disconnect during command acceptance aborts the handler signal and suppresses a late acknowledgment', async t=>{
 let resolve,signal
 const accepted=new Promise(r=>resolve=r)
 const f=fixture({commandTarget:{registration:()=>({baseRevision:revision,editorGeneration:0,leaseEpoch:1,capabilities:['docx.append']}),onCommand:(_command,s)=>{signal=s;return accepted}}})
 t.after(()=>f.bridge.dispose())
 await waitFor(()=>f.sockets.length)
 const socket=f.sockets[0];socket.open();socket.message({type:'state',headRevision:revision,generation:1,lease})
 await waitFor(()=>socket.sent.some(m=>m.type==='register'))
 const request=socket.sent.find(m=>m.type==='register'),connectionId='66666666-6666-4666-8666-666666666666',epoch='77777777-7777-4777-8777-777777777777'
 socket.message({...request,type:'registered',connectionId,epoch})
 socket.message({type:'command',connectionId,epoch,editorId,deliveryId:'88888888-8888-4888-8888-888888888888',claimId:'99999999-9999-4999-8999-999999999999',digest:'d'.repeat(64),envelope:{commandId,fileId,baseRevision:revision,editorGeneration:0,leaseEpoch:1,argsHash:'a'.repeat(64),payload:{toolName:'docx.append',arguments:{text:'allowed'}}}})
 await waitFor(()=>signal)
 socket.disconnect();assert.equal(signal.aborted,true)
 resolve(true);await new Promise(r=>setTimeout(r,10))
 assert.equal(socket.sent.some(m=>m.type==='ack'),false)
})


test('the bounded delivery-id cache reconnects instead of silently rejecting all later commands', async t=>{
 const f=fixture({commandTarget:{registration:()=>({baseRevision:revision,editorGeneration:0,leaseEpoch:1,capabilities:['docx.append']}),onCommand:async()=>true}})
 t.after(()=>f.bridge.dispose())
 await waitFor(()=>f.sockets.length)
 const socket=f.sockets[0];socket.open();socket.message({type:'state',headRevision:revision,generation:1,lease})
 await waitFor(()=>socket.sent.some(message=>message.type==='register'))
 const registration=socket.sent.find(message=>message.type==='register'),connectionId='66666666-6666-4666-8666-666666666666',epoch='77777777-7777-4777-8777-777777777777'
 socket.message({...registration,type:'registered',connectionId,epoch})
 const command=()=>({type:'command',connectionId,epoch,editorId,deliveryId:crypto.randomUUID(),claimId:crypto.randomUUID(),digest:'d'.repeat(64),envelope:{commandId:crypto.randomUUID(),fileId,baseRevision:revision,editorGeneration:0,leaseEpoch:1,argsHash:'a'.repeat(64),payload:{toolName:'docx.append',arguments:{}}}})
 for(let i=0;i<64;i++){socket.message(command());await Promise.resolve();await Promise.resolve()}
 assert.equal(socket.sent.filter(message=>message.type==='ack').length,64)
 socket.message(command())
 await waitFor(()=>f.sockets.length===2)
 assert.equal(socket.readyState,3)
 assert.equal(f.sockets[1].sent.length,0,'no command is automatically replayed on a new connection')
})
