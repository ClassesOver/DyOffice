import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connect as connectTcp } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { restrictedOrigin, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { buildLocalApp } from '../../server/src/app.ts'
import { password } from '../helpers/identity.mjs'
import { createSessionFileHost } from '../../../../packages/browser-host/src/session-files.ts'
import { createCommandService } from '../../server/src/modules/commands/service.ts'
import { createEditorBridge } from '../../../../packages/browser-host/src/editor-bridge.ts'
import { createPostgresCommandJournal } from '../../server/src/modules/commands/postgres-journal.ts'
import { commandHash } from '../../server/src/modules/commands/approval.ts'
import { REALTIME_UUID_PATTERN, decodeRealtimeServerMessage } from '../../../../packages/web-contracts/src/realtime.ts'

function signedHeaders(f, token) {
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  return { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token) }
}
const deadline = (promise, ms = 6000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation timed out')), ms) })]).finally(() => clearTimeout(timer))
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t, options = {}) {
  const f = await fileFixture(t)
  // Explicitly configure the real application without changing shared fixtures.
  await f.app.close()
  f.app = await buildLocalApp({ db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId,
    origin: restrictedOrigin, csrfKey: f.csrfKey, objectStore: f.objects,
    realtime: { pollIntervalMs: 60, heartbeatIntervalMs: 30_000, ...options },
    realtimeCommands: options.commandPolicy, onRealtimeReady: server => { f.realtime = server },
  })
  const sockets = new Set()
  f.cleanup.unshift(async () => {
    await Promise.all([...sockets].map(async ws => {
      if (ws.readyState === WebSocket.CLOSED) return
      const closed = once(ws, 'close').catch(() => {})
      ws.terminate()
      await deadline(closed)
    }))
    await f.app.close()
  })
  f.sockets = sockets
  f.original = await docxBytes()
  f.aliceFile = (await importFile(f, f.alice.token, f.original, 'realtime-alice.docx')).file
  f.bobFile = (await importFile(f, f.bob.token, f.original, 'realtime-bob.docx')).file
  f.address = await f.app.listen({ port: 0, host: '127.0.0.1' })
  return f
}
async function http(f, token, path, body, extra = {}) {
  const response = await fetch(f.address + path, { method: 'POST', headers: { ...signedHeaders(f, token), 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
const ticketFor = (f, token = f.alice.token, fileId = f.aliceFile.fileId, editorId = null, extra = {}) => http(f, token, '/api/v1/realtime/ticket', { fileId, editorId }, extra)
function track(ws) {
  const messages = [], waiters = new Set()
  let closeCode
  const closed = new Promise(resolve => ws.once('close', code => { closeCode = code; resolve(code) }))
  ws.on('message', raw => {
    const message = decodeRealtimeServerMessage(raw.toString())
    assert.ok(message, 'server sends a valid contract message: ' + raw)
    messages.push(message)
    for (const waiter of [...waiters]) if (waiter.predicate(message)) { waiters.delete(waiter); waiter.resolve(message) }
  })
  ws.on('error', () => {})
  return {
    messages, closed, get closeCode() { return closeCode },
    async wait(predicate, after = 0) {
      const existing = messages.slice(after).find(predicate)
      if (existing) return existing
      let waiter
      try { return await deadline(new Promise((resolve, reject) => {
        waiter = { predicate, resolve }; waiters.add(waiter)
        void closed.then(() => reject(new Error('closed before expected message; code=' + closeCode + '; messages=' + JSON.stringify(messages))))
      })) } finally { if (waiter) waiters.delete(waiter) }
    },
  }
}
async function open(f, { token = f.alice.token, fileId = f.aliceFile.fileId, editorId = null, ticket, origin = restrictedOrigin, autoPong = true } = {}) {
  if (!ticket) { const issued = await ticketFor(f, token, fileId, editorId); assert.equal(issued.status, 201); ticket = issued.body.ticket }
  const ws = new WebSocket('ws://' + new URL(f.address).host + '/realtime?ticket=' + encodeURIComponent(ticket), {
    headers: { Origin: origin, Cookie: '__Host-dyoffice-session=' + token }, autoPong,
  })
  f.sockets.add(ws)
  const state = track(ws)
  // Listener attached immediately, never after awaiting a helper or state frame.
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); reject(Object.assign(new Error('upgrade rejected'), { status: response.statusCode })) })
  })
  await deadline(opened)
  const hello = await state.wait(message => message.type === 'state')
  assert.equal(state.messages[0].type, 'state')
  assert.equal(hello.generation, 1)
  return { ws, ...state, state, hello, ticket }
}
async function rejectedUpgrade(f, { token = f.alice.token, ticket, origin = restrictedOrigin } = {}) {
  const ws = new WebSocket('ws://' + new URL(f.address).host + '/realtime?ticket=' + encodeURIComponent(ticket), {
    headers: { Origin: origin, Cookie: '__Host-dyoffice-session=' + token },
  })
  f.sockets.add(ws); ws.on('error', () => {})
  return deadline(new Promise(resolve => {
    ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); ws.terminate() })
    ws.once('open', () => { ws.terminate(); resolve(101) })
  }))
}
async function disconnect(connection) { connection.ws.close(); await deadline(connection.closed) }
const send = (connection, message) => connection.ws.send(JSON.stringify(message))
const acquire = (f, editorId, token = f.alice.token, fileId = f.aliceFile.fileId) => http(f, token, '/api/v1/files/' + fileId + '/lease', { editorId })
function saveHost(f, token, editorId) {
  return createSessionFileHost({ editorId, fetchImpl: (path, init = {}) => fetch(f.address + path, {
    ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token },
  }) })
}
async function owned(f, token, operation) { return f.transactions.withPrincipalTransaction({ kind: 'session', token }, operation) }

const fixedTool = { name: 'docs.replace_text.v1', schemaVersion: 1, effect: 'document_write', executionMode: 'live_editor', requiresActiveEditor: true,
  requiredScopes: ['files:write'], maxDurationMs: 1000, inputSchema: {}, outputSchema: {} }
const commandPolicy = {
  lookupTool: name => name === fixedTool.name ? fixedTool : undefined,
  validateCommand: envelope => {
    const args = envelope.payload.arguments
    return envelope.payload.toolName === fixedTool.name && args && Object.keys(args).sort().join(',') === 'expectedText,from,replacement,to' &&
      Number.isSafeInteger(args.from) && Number.isSafeInteger(args.to) && args.from >= 1 && args.to >= args.from &&
      typeof args.expectedText === 'string' && typeof args.replacement === 'string' && args.replacement.length <= 1024
  },
}
async function register(f, connection, editorGeneration = 3, capabilities = [fixedTool.name]) {
  const request = { type: 'register', requestId: randomUUID(), baseRevision: f.aliceFile.revision, editorGeneration,
    leaseEpoch: connection.hello.lease.leaseEpoch, capabilities }
  send(connection, request)
  return connection.wait(m => m.type === 'registered' && m.requestId === request.requestId)
}
async function approvedCommand(f, editorId, { generation = 3, approve = true } = {}) {
  const lease = await acquire(f, editorId); assert.equal(lease.status, 200)
  const args = { from: 1, to: 1, expectedText: '', replacement: 'approved append' }
  const envelope = { commandId: randomUUID(), fileId: f.aliceFile.fileId, baseRevision: f.aliceFile.revision, editorGeneration: generation,
    leaseEpoch: lease.body.leaseEpoch, argsHash: commandHash(args), payload: { toolName: fixedTool.name, arguments: args } }
  const base = { editorId, currentGeneration: generation, envelope }
  const proposed = await http(f, f.alice.token, '/api/v1/commands/propose', base)
  assert.equal(proposed.status, 200)
  if (approve) assert.equal((await http(f, f.alice.token, '/api/v1/commands/approve', { ...base, digest: proposed.body.digest })).status, 200)
  return { envelope, digest: proposed.body.digest, base }
}
const ack = (connection, message, patch = {}) => send(connection, { type: 'ack', connectionId: message.connectionId, epoch: message.epoch,
  deliveryId: message.deliveryId, commandId: message.envelope.commandId, claimId: message.claimId, status: 'delivered', ...patch })
const dispatch = (f, registered, command, senderToken = f.alice.token) => f.realtime.dispatchToEditor({ senderToken,
  connectionId: registered.connectionId, epoch: registered.epoch, envelope: command.envelope, digest: command.digest })

// Baseline draft failure is retained in realtime-initial-failure.log (35s timeout).
test('real HTTP ticket endpoint binds editor and returns real UUID state, sync and ping', { timeout: 20_000 }, async t => {
  const f = await fixture(t), editorId = randomUUID()
  for (const body of [{ fileId: f.aliceFile.fileId }, { fileId: f.aliceFile.fileId, editorId: 'bad' }, { fileId: f.aliceFile.fileId, editorId, extra: true }]) {
    assert.equal((await http(f, f.alice.token, '/api/v1/realtime/ticket', body)).status, 400)
  }
  assert.equal((await ticketFor(f, f.alice.token, randomUUID())).status, 404)
  assert.equal((await ticketFor(f, f.bob.token)).status, 404)
  assert.equal((await ticketFor(f, f.alice.token, f.aliceFile.fileId, editorId, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await ticketFor(f, f.alice.token, f.aliceFile.fileId, editorId, { 'x-csrf-token': '' })).status, 403)
  const connection = await open(f, { editorId })
  assert.match(connection.hello.headRevision, REALTIME_UUID_PATTERN)
  assert.equal(connection.hello.headRevision, f.aliceFile.revision)
  assert.equal(connection.hello.lease.active, false)
  const binding = await owned(f, f.alice.token, c => c.query('SELECT editor_id,session_id,used_at FROM realtime_tickets WHERE file_id=$1', [f.aliceFile.fileId]))
  assert.equal(binding.rows[0].editor_id, editorId)
  assert.equal(binding.rows[0].session_id, f.alice.sessionId)
  assert.ok(binding.rows[0].used_at)
  send(connection, { type: 'ping' }); await connection.wait(m => m.type === 'pong')
  send(connection, { type: 'sync' })
  const sync = await connection.wait(m => m.type === 'state' && m.generation === 2)
  assert.equal(sync.headRevision, f.aliceFile.revision)
})

test('tickets are durable one-use and wrong user/session/origin cannot burn the valid credential', { timeout: 20_000 }, async t => {
  const f = await fixture(t), otherSession = await f.sessions.login('alice', password)
  const issued = await ticketFor(f)
  for (const [token, origin, expected] of [[f.bob.token, restrictedOrigin, 401], [otherSession.token, restrictedOrigin, 401], [f.alice.token, 'https://evil.example', 403]]) {
    assert.equal(await rejectedUpgrade(f, { token, origin, ticket: issued.body.ticket }), expected)
  }
  const first = await open(f, { ticket: issued.body.ticket })
  assert.equal(first.hello.headRevision, f.aliceFile.revision)
  assert.equal(await rejectedUpgrade(f, { ticket: issued.body.ticket }), 401)
  const row = await owned(f, f.alice.token, c => c.query('SELECT count(*)::integer AS n FROM realtime_tickets WHERE used_at IS NOT NULL'))
  assert.equal(row.rows[0].n, 1)
})

test('expired tickets and sessions cannot upgrade or receive state', { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const issued = await ticketFor(f)
  await owned(f, f.alice.token, c => c.query("UPDATE realtime_tickets SET created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute'"))
  assert.equal(await rejectedUpgrade(f, { ticket: issued.body.ticket }), 401)
  const next = await ticketFor(f)
  await f.db.pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.alice.sessionId])
  assert.equal(await rejectedUpgrade(f, { ticket: next.body.ticket }), 401)
})

test('revocation is rechecked on a message and idle polling never leaks a new head to a revoked session', { timeout: 20_000 }, async t => {
  const f = await fixture(t), stale = await open(f), writerSession = await f.sessions.login('alice', password)
  const editorId = randomUUID(), host = saveHost(f, writerSession.token, editorId)
  t.after(() => host.dispose())
  await host.open(f.aliceFile.fileId); await host.acquireLease(f.aliceFile.fileId)
  await f.sessions.logout(f.alice.token)
  send(stale, { type: 'sync' })
  const error = await stale.wait(m => m.type === 'error')
  assert.equal(error.code, 'unauthorized')
  await deadline(stale.closed)
  const committed = await host.save(f.aliceFile.fileId, new Uint8Array(f.original))
  assert.notEqual(committed.revision, f.aliceFile.revision)
  assert.equal(stale.messages.some(m => (m.type === 'file-event' ? m.fileEvent.headRevision : m.headRevision) === committed.revision), false)
})

test('passive polling drops an expired connection without any client frame', { timeout: 20_000 }, async t => {
  const f = await fixture(t), connection = await open(f)
  await f.db.pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.alice.sessionId])
  await deadline(connection.closed)
  assert.equal(connection.state.closeCode, 4401)
  assert.equal(connection.messages.filter(m => m.type === 'state').length, 1)
})

test('browser writer announcements are rejected and never alter or broadcast the file head', { timeout: 20_000 }, async t => {
  const f = await fixture(t), attacker = await open(f), observer = await open(f)
  for (const message of [{ type: 'file-event', fileEvent: { headRevision: randomUUID(), generation: 999 } }, { type: 'editor-command', payload: { command: 'write' } }, { type: 'sync', headRevision: randomUUID() }]) {
    const after = attacker.messages.length
    send(attacker, message)
    await attacker.wait(m => m.type === 'error' && m.code === 'invalid-message', after)
  }
  send(observer, { type: 'sync' })
  const state = await observer.wait(m => m.type === 'state' && m.generation === 2)
  assert.equal(state.headRevision, f.aliceFile.revision)
  assert.equal(observer.messages.some(m => m.type === 'editor-command' || m.type === 'file-event'), false)
})

test('T06 HTTP commit is discovered by DB polling for authorized connections only', { timeout: 20_000 }, async t => {
  const f = await fixture(t), alice = await open(f), bob = await open(f, { token: f.bob.token, fileId: f.bobFile.fileId })
  const editorId = randomUUID(), host = saveHost(f, f.alice.token, editorId)
  t.after(() => host.dispose())
  await host.open(f.aliceFile.fileId); await host.acquireLease(f.aliceFile.fileId)
  const saved = await host.save(f.aliceFile.fileId, new Uint8Array(f.original))
  const event = await alice.wait(m => m.type === 'file-event' && m.fileEvent.headRevision === saved.revision)
  assert.ok(event.fileEvent.generation > 1)
  assert.equal(event.fileEvent.lease.editorId, editorId)
  send(bob, { type: 'sync' })
  const bobState = await bob.wait(m => m.type === 'state' && m.generation === 2)
  assert.equal(bobState.headRevision, f.bobFile.revision)
  assert.equal(bob.messages.some(m => m.type === 'file-event' && m.fileEvent.headRevision === saved.revision), false)
})

test('offline WS leaves T06 HTTP save functional and reconnect only reports the committed UUID without another save', { timeout: 20_000 }, async t => {
  const f = await fixture(t), editorId = randomUUID(), host = saveHost(f, f.alice.token, editorId), connection = await open(f, { editorId })
  t.after(() => host.dispose())
  await host.open(f.aliceFile.fileId); await host.acquireLease(f.aliceFile.fileId)
  await disconnect(connection)
  const saved = await host.save(f.aliceFile.fileId, new Uint8Array(f.original))
  const before = await owned(f, f.alice.token, c => c.query('SELECT count(*)::integer AS n FROM revision_commits WHERE file_id=$1', [f.aliceFile.fileId]))
  const back = await open(f, { editorId })
  assert.equal(back.hello.headRevision, saved.revision)
  assert.equal(back.hello.generation, 1)
  assert.match(back.hello.headRevision, REALTIME_UUID_PATTERN)
  send(back, { type: 'sync' }); await back.wait(m => m.type === 'state' && m.generation === 2)
  await pause(150)
  const after = await owned(f, f.alice.token, c => c.query('SELECT count(*)::integer AS n FROM revision_commits WHERE file_id=$1', [f.aliceFile.fileId]))
  assert.equal(after.rows[0].n, before.rows[0].n, 'reconnect does not submit a second draft')
  assert.equal((await f.files.openFile(f.alice.token, f.aliceFile.fileId)).file.revision, saved.revision)
  assert.equal(back.messages.some(m => m.type === 'editor-command'), false)
})

test('same session editors observe takeover but only the exact editor binding holds the lease', { timeout: 20_000 }, async t => {
  const f = await fixture(t), editor1 = randomUUID(), editor2 = randomUUID()
  assert.equal((await acquire(f, editor1)).status, 200)
  const first = await open(f, { editorId: editor1 }), second = await open(f, { editorId: editor2 }), reader = await open(f)
  const held = (connection, snapshot) => snapshot.lease.active && snapshot.lease.heldByCurrentSession && snapshot.lease.editorId === connection
  assert.equal(held(editor1, first.hello), true)
  assert.equal(held(editor2, second.hello), false)
  assert.equal(held(null, reader.hello), false)
  assert.equal((await acquire(f, editor2)).status, 409)
  const takeover = await http(f, f.alice.token, '/api/v1/files/' + f.aliceFile.fileId + '/lease/takeover', { editorId: editor2, expectedEpoch: first.hello.lease.leaseEpoch })
  assert.equal(takeover.status, 200)
  for (const connection of [first, second, reader]) {
    const message = await connection.wait(m => m.type === 'file-event' && m.fileEvent.lease.editorId === editor2)
    assert.equal(message.fileEvent.lease.leaseEpoch, 2)
    assert.equal(message.fileEvent.lease.heldByCurrentSession, true)
    assert.equal(held(connection === first ? editor1 : connection === second ? editor2 : null, message.fileEvent), connection === second)
  }
})

test('reconcile reads real T14 durable state in owner/session/file scope and performs no journal transition', { timeout: 20_000 }, async t => {
  const f = await fixture(t), editorId = randomUUID(), lease = await acquire(f, editorId)
  assert.equal(lease.status, 200)
  const tool = { name: 'replace_text', schemaVersion: 1, effect: 'document_write', executionMode: 'live_editor', requiresActiveEditor: true,
    requiredScopes: ['files:write'], maxDurationMs: 1000, inputSchema: {}, outputSchema: {} }
  const envelope = { commandId: randomUUID(), fileId: f.aliceFile.fileId, baseRevision: f.aliceFile.revision, editorGeneration: 3,
    leaseEpoch: lease.body.leaseEpoch, argsHash: commandHash({ text: 'hello' }), payload: { toolName: 'replace_text', arguments: { text: 'hello' } } }
  const journal = createPostgresCommandJournal({ transactions: f.transactions, token: f.alice.token, editorId, editorGeneration: 3 })
  const commands = createCommandService({ journal, lookupTool: () => tool })
  const proposal = await commands.proposeCommand(envelope)
  await commands.approveCommand(envelope, proposal.digest)
  const connection = await open(f, { editorId }), missing = randomUUID(), requestId = randomUUID()
  const before = await owned(f, f.alice.token, c => c.query('SELECT record,updated_at FROM command_journal WHERE command_id=$1', [envelope.commandId]))
  send(connection, { type: 'reconcile', requestId, commandIds: [envelope.commandId, missing] })
  const result = await connection.wait(m => m.type === 'command-state' && m.requestId === requestId)
  assert.deepEqual(result.commands, [{ commandId: envelope.commandId, state: 'approved' }, { commandId: missing, state: null }])
  const after = await owned(f, f.alice.token, c => c.query('SELECT record,updated_at FROM command_journal WHERE command_id=$1', [envelope.commandId]))
  assert.deepEqual(after.rows, before.rows)
  const otherSession = await f.sessions.login('alice', password)
  for (const other of [await open(f, { token: otherSession.token }), await open(f, { token: f.bob.token, fileId: f.bobFile.fileId }), await open(f, { fileId: (await importFile(f, f.alice.token, f.original)).file.fileId })]) {
    const id = randomUUID(); send(other, { type: 'reconcile', requestId: id, commandIds: [envelope.commandId] })
    assert.deepEqual((await other.wait(m => m.type === 'command-state' && m.requestId === id)).commands, [{ commandId: envelope.commandId, state: null }])
  }
  await disconnect(connection)
  const back = await open(f, { editorId })
  await pause(100)
  assert.equal(back.messages.some(m => m.type === 'command-state' || m.type === 'editor-command'), false)
})

test('a separate HTTP server process commits T06 and polling discovers its UUID without pubsub', { timeout: 20_000 }, async t => {
  const f = await fixture(t), observer = await open(f), editorId = randomUUID()
  // Local-dev object storage explicitly cannot be shared across writers.
  // Give the independent HTTP process its own store and seed its immutable base.
  const { mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { createLocalObjectStore } = await import('../../server/src/storage/local-dev.ts')
  const childDirectory = join(f.directory, 'realtime-child')
  await mkdir(childDirectory)
  await (await createLocalObjectStore({ directory: childDirectory })).putImmutable(f.deploymentId + '/' + f.alice.user.id + '/objects/' + f.aliceFile.revision, f.original)
  const paths = new URL('../../server/src/', import.meta.url)
  const code = `
    import {Pool} from ${JSON.stringify(import.meta.resolve('pg'))};
    import {createIdentityStore} from ${JSON.stringify(new URL('db/identity.ts', paths).href)};
    import {buildLocalApp} from ${JSON.stringify(new URL('app.ts', paths).href)};
    import {createLocalObjectStore} from ${JSON.stringify(new URL('storage/local-dev.ts', paths).href)};
    import {createSessionFileHost} from ${JSON.stringify(new URL('../../../../packages/browser-host/src/session-files.ts', import.meta.url).href)};
    const input=JSON.parse(process.env.REALTIME_CHILD);
    const auth=new Pool({connectionString:input.auth}),business=new Pool({connectionString:input.business});
    const app=await buildLocalApp({db:createIdentityStore(auth),businessPool:business,deploymentId:input.deploymentId,origin:input.origin,csrfKey:input.csrfKey,objectStore:await createLocalObjectStore({directory:input.directory})});
    const address=await app.listen({port:0,host:'127.0.0.1'});
    const host=createSessionFileHost({editorId:input.editorId,fetchImpl:(path,init={})=>fetch(address+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),origin:input.origin,cookie:'__Host-dyoffice-session='+input.token}})});
    try {await host.open(input.fileId);await host.acquireLease(input.fileId);const saved=await host.save(input.fileId,new Uint8Array(Buffer.from(input.bytes,'base64')));process.stdout.write(JSON.stringify(saved));}
    finally {host.dispose();await app.close();await auth.end();await business.end();}
  `
  // --input-type=module propagates to validation Worker execArgv and rejects
  // its file entrypoint. The require launcher avoids changing child worker args.
  const launcher = 'import("data:text/javascript,"+encodeURIComponent(' + JSON.stringify(code) + ')).catch(error=>{console.error(error);process.exitCode=1})'
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', launcher], {
    cwd: new URL('../..', import.meta.url), env: { ...process.env, REALTIME_CHILD: JSON.stringify({ auth: f.urls.auth, business: f.urls.business,
      deploymentId: f.deploymentId, origin: restrictedOrigin, csrfKey: f.csrfKey, directory: childDirectory, token: f.alice.token,
      fileId: f.aliceFile.fileId, editorId, bytes: f.original.toString('base64') }) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
  const exit = await deadline(new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }), 10_000)
  assert.equal(exit, 0, errors)
  const saved = JSON.parse(output)
  assert.match(saved.revision, REALTIME_UUID_PATTERN)
  const event = await observer.wait(m => m.type === 'file-event' && m.fileEvent.headRevision === saved.revision)
  assert.equal(event.fileEvent.lease.editorId, editorId)
})

test('durable consumed tickets cannot be reused after the app is rebuilt', { timeout: 20_000 }, async t => {
  const f = await fixture(t), connection = await open(f)
  const ticket = connection.ticket
  await disconnect(connection); await f.app.close()
  f.app = await buildLocalApp({ db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId,
    origin: restrictedOrigin, csrfKey: f.csrfKey, objectStore: f.objects, realtime: { pollIntervalMs: 60 } })
  f.address = await f.app.listen({ port: 0, host: '127.0.0.1' })
  assert.equal(await rejectedUpgrade(f, { ticket }), 401)
  assert.equal((await open(f)).hello.headRevision, f.aliceFile.revision)
})

test('sync waits for file/lease writers then reads one coherent head and lease snapshot', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { pollIntervalMs: 60_000 }), editorId = randomUUID(), connection = await open(f, { editorId })
  const host = saveHost(f, f.alice.token, editorId)
  t.after(() => host.dispose())
  await host.open(f.aliceFile.fileId); await host.acquireLease(f.aliceFile.fileId)
  const saved = await host.save(f.aliceFile.fileId, new Uint8Array(f.original))
  const lock = await f.ownerPool.connect()
  await lock.query('BEGIN'); await lock.query('SELECT 1 FROM files WHERE id=$1 FOR UPDATE', [f.aliceFile.fileId])
  try {
    send(connection, { type: 'sync' })
    await waitForDatabaseLock(f, 'business')
    // The lifecycle trigger also locks files; use the transaction that owns
    // the file lock rather than deadlocking test setup through a second one.
    await lock.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true)", [f.deploymentId, f.alice.user.id, f.alice.sessionId])
    await lock.query('UPDATE edit_leases SET lease_epoch=lease_epoch+1 WHERE file_id=$1', [f.aliceFile.fileId])
    await lock.query('COMMIT')
    const state = await connection.wait(m => m.type === 'state' && m.generation === 2)
    assert.equal(state.headRevision, saved.revision)
    assert.equal(state.lease.leaseEpoch, 2)
    assert.equal(state.lease.editorId, editorId)
  } finally { await lock.query('ROLLBACK'); lock.release() }
})

test('session expiry during a blocked state read is rechecked before any state can be sent', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { pollIntervalMs: 60_000 }), connection = await open(f)
  await f.db.pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [f.alice.sessionId])
  const lock = await f.ownerPool.connect()
  await lock.query('BEGIN'); await lock.query('SELECT 1 FROM files WHERE id=$1 FOR UPDATE', [f.aliceFile.fileId])
  try {
    send(connection, { type: 'sync' })
    await waitForDatabaseLock(f, 'business')
    await pause(550)
    await lock.query('COMMIT')
    await deadline(connection.closed)
    assert.equal(connection.messages.filter(m => m.type === 'state').length, 1)
    assert.equal(connection.messages.filter(m => m.type === 'file-event').length, 0)
    assert.equal(connection.messages.at(-1).code, 'unauthorized')
  } finally { await lock.query('ROLLBACK'); lock.release() }
})

test('controlled T14 dispatch requires approval and exact holder, records delivered ack only, then HTTP binds a real T06 receipt', { timeout: 25_000 }, async t => {
  const f = await fixture(t, { commandPolicy, ackTimeoutMs: 2000 }), editorId = randomUUID()
  const command = await approvedCommand(f, editorId, { approve: false })
  const holder = await open(f, { editorId }), observer = await open(f, { editorId: randomUUID() })
  const registered = await register(f, holder)
  assert.equal((await dispatch(f, registered, command)).status, 'conflict', 'pending approval is never dispatched')
  assert.equal((await http(f, f.alice.token, '/api/v1/commands/approve', { ...command.base, digest: command.digest })).status, 200)
  const delivery = dispatch(f, registered, command)
  const message = await holder.wait(m => m.type === 'command')
  assert.deepEqual(message.envelope, command.envelope)
  assert.equal(message.editorId, editorId)
  assert.equal(observer.messages.some(m => m.type === 'command'), false)
  // Wrong ack cannot resolve or advance a command. A precise ack only delivers.
  ack(holder, message, { claimId: randomUUID() })
  await holder.wait(m => m.type === 'error' && m.code === 'permission-denied')
  ack(holder, message)
  const delivered = await delivery
  assert.equal(delivered.status, 'delivered')
  assert.equal(delivered.claimId, message.claimId)
  const claimed = await owned(f, f.alice.token, c => c.query('SELECT record FROM command_journal WHERE command_id=$1', [command.envelope.commandId]))
  assert.equal(claimed.rows[0].record.state, 'unknown_outcome', 'WS ack is not an applied receipt')
  assert.equal((await dispatch(f, registered, command)).status, 'conflict', 'duplicate commandId cannot dispatch twice')
  const applied = await http(f, f.alice.token, '/api/v1/commands/applied', { ...command.base, currentGeneration: 4, generation: 4, claimId: message.claimId })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.state, 'applied_uncommitted')
  const upload = await http(f, f.alice.token, '/api/v1/files/' + f.aliceFile.fileId + '/uploads', { size: f.original.length,
    baseRevision: f.aliceFile.revision, leaseEpoch: command.envelope.leaseEpoch, editorId })
  assert.equal(upload.status, 201)
  const bytes = await fetch(f.address + '/api/v1/uploads/' + upload.body.uploadId + '/content', { method: 'PUT',
    headers: { ...signedHeaders(f, f.alice.token), 'content-type': 'application/octet-stream' }, body: f.original })
  assert.equal(bytes.status, 200)
  const key = randomUUID()
  assert.equal((await http(f, f.alice.token, '/api/v1/commands/bind', { ...command.base, currentGeneration: 4, digest: command.digest,
    uploadId: upload.body.uploadId, sha256: f.aliceFile.sha256, size: f.original.length, idempotencyKey: key })).status, 200)
  const committed = await http(f, f.alice.token, '/api/v1/files/' + f.aliceFile.fileId + '/commits', { fileId: f.aliceFile.fileId,
    uploadId: upload.body.uploadId, baseRevision: f.aliceFile.revision, leaseEpoch: command.envelope.leaseEpoch, idempotencyKey: key, sourceCommandId: command.envelope.commandId })
  assert.equal(committed.status, 200)
  const outcome = await http(f, f.alice.token, '/api/v1/commands/outcome', { ...command.base, currentGeneration: 4 })
  assert.equal(outcome.status, 200); assert.equal(outcome.body.state, 'committed')
  assert.equal(outcome.body.revision.revision, committed.body.revision)
  const routing = await owned(f, f.alice.token, c => c.query('SELECT * FROM realtime_command_deliveries WHERE command_id=$1', [command.envelope.commandId]))
  assert.equal(routing.rowCount, 1)
  assert.equal(routing.rows[0].connection_id, registered.connectionId)
  assert.equal(routing.rows[0].claim_id, message.claimId)
  await assert.rejects(() => owned(f, f.alice.token, c => c.query('DELETE FROM realtime_command_deliveries')), { code: '42501' })
})

test('controlled dispatch fences sender session, stale document generation, editor takeover and old connection epoch', { timeout: 25_000 }, async t => {
  const f = await fixture(t, { commandPolicy, ackTimeoutMs: 500 }), editorId = randomUUID(), command = await approvedCommand(f, editorId)
  const holder = await open(f, { editorId }), other = await open(f, { editorId: randomUUID() })
  const request = { type: 'register', requestId: randomUUID(), baseRevision: f.aliceFile.revision, editorGeneration: 3, leaseEpoch: 1, capabilities: [fixedTool.name] }
  send(other, request); await other.wait(m => m.type === 'error' && m.code === 'permission-denied')
  const registered = await register(f, holder)
  const otherSession = await f.sessions.login('alice', password)
  assert.equal((await dispatch(f, registered, command, otherSession.token)).status, 'unauthorized')
  assert.equal((await dispatch(f, { ...registered, epoch: randomUUID() }, command)).status, 'unavailable')
  await register(f, holder, 4)
  assert.equal((await dispatch(f, registered, command)).status, 'unavailable', 'registration generation no longer matches approval')
  send(holder, { ...request, requestId: randomUUID() })
  await holder.wait(m => m.type === 'error' && m.code === 'permission-denied')
  const nextEditor = randomUUID()
  assert.equal((await http(f, f.alice.token, '/api/v1/files/' + f.aliceFile.fileId + '/lease/takeover', { editorId: nextEditor, expectedEpoch: 1 })).status, 200)
  const newHolder = await open(f, { editorId: nextEditor })
  const registration2 = await register(f, newHolder, 3)
  assert.equal(registration2.leaseEpoch, 2)
  assert.equal((await dispatch(f, registration2, command)).status, 'unavailable', 'old lease epoch cannot be dispatched to the new holder')
  assert.equal(holder.messages.some(m => m.type === 'command'), false)
  assert.equal(newHolder.messages.some(m => m.type === 'command'), false)
})

test('disconnect after durable command claim stays unknown and reconnect reconcile never redelivers it', { timeout: 25_000 }, async t => {
  const f = await fixture(t, { commandPolicy, ackTimeoutMs: 500 }), editorId = randomUUID(), command = await approvedCommand(f, editorId)
  const holder = await open(f, { editorId }), registered = await register(f, holder)
  const result = dispatch(f, registered, command)
  await holder.wait(m => m.type === 'command')
  await disconnect(holder)
  assert.equal((await result).status, 'unknown_outcome')
  const back = await open(f, { editorId }), registration2 = await register(f, back)
  const requestId = randomUUID()
  send(back, { type: 'reconcile', requestId, commandIds: [command.envelope.commandId] })
  assert.deepEqual((await back.wait(m => m.type === 'command-state' && m.requestId === requestId)).commands,
    [{ commandId: command.envelope.commandId, state: 'unknown_outcome' }])
  assert.equal((await dispatch(f, registration2, command)).status, 'conflict')
  assert.equal(back.messages.some(m => m.type === 'command'), false)
})

test('missing or cross-socket delivery ack times out unknown and leaves the durable claim unreplayed', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { commandPolicy, ackTimeoutMs: 300 }), editorId = randomUUID(), command = await approvedCommand(f, editorId)
  const holder = await open(f, { editorId }), sibling = await open(f, { editorId })
  const registered = await register(f, holder)
  const delivery = dispatch(f, registered, command)
  const message = await holder.wait(m => m.type === 'command')
  ack(sibling, message)
  await sibling.wait(m => m.type === 'error' && m.code === 'permission-denied')
  assert.equal((await delivery).status, 'unknown_outcome')
  assert.equal((await dispatch(f, registered, command)).status, 'conflict')
  const state = await owned(f, f.alice.token, c => c.query('SELECT state FROM command_journal WHERE command_id=$1', [command.envelope.commandId]))
  assert.equal(state.rows[0].state, 'unknown_outcome')
})

test('real PG revocation after durable claim prevents the instrumented sender from emitting command data', { timeout: 20_000 }, async t => {
  let claimStored, release
  const ready = new Promise(resolve => { claimStored = resolve }), gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { commandPolicy, ackTimeoutMs: 300, pollIntervalMs: 60_000 }), editorId = randomUUID(), command = await approvedCommand(f, editorId)
  const { createRealtimeCommands } = await import('../../server/src/modules/realtime/commands.ts')
  const { createRealtimeRegistry } = await import('../../server/src/modules/realtime/sessions.ts')
  const { createRealtimeState } = await import('../../server/src/modules/realtime/state.ts')
  // Gate only after the real transaction COMMIT: revocation can win before
  // the delivery authorization transaction, without fake journal state.
  const transactions = { sessionIdleMs: f.transactions.sessionIdleMs, async withPrincipalTransaction(credential, operation) {
    const result = await f.transactions.withPrincipalTransaction(credential, operation)
    if (result?.state === 'unknown_outcome') { claimStored(); await gate }
    return result
  } }
  const registry = createRealtimeRegistry(), serverSocket = { readyState: 1, bufferedAmount: 0, on() {}, once() {},
    sent: [], send(text, callback) { this.sent.push(JSON.parse(text)); callback?.() }, terminate() { this.readyState = 3 }, ping() {} }
  t.after(() => registry.close())
  const identity = { deploymentId: f.deploymentId, userId: f.alice.user.id, sessionId: f.alice.sessionId,
    fileId: f.aliceFile.fileId, editorId, token: f.alice.token }
  const connection = registry.registerEditor(identity, serverSocket, registry.reserve(identity))
  connection.registration = { requestId: randomUUID(), baseRevision: f.aliceFile.revision, editorGeneration: 3, leaseEpoch: 1, capabilities: [fixedTool.name] }
  const service = createRealtimeCommands({ transactions, registry, state: createRealtimeState({ transactions }), policy: commandPolicy, ackTimeoutMs: 300 })
  const dispatching = service.dispatchToEditor({ senderToken: f.alice.token, connectionId: connection.connectionId, epoch: connection.epoch, ...command })
  try {
    await deadline(ready)
    await f.sessions.logout(f.alice.token)
    release()
    assert.equal((await dispatching).status, 'unknown_outcome')
    assert.deepEqual(serverSocket.sent, [])
  } finally { release(); await dispatching }
})

test('real browser client adapter registers a trusted target, receives one durable command and sends exact delivered ack', { timeout: 25_000 }, async t => {
  const f = await fixture(t, { commandPolicy, ackTimeoutMs: 2000 }), editorId = randomUUID(), command = await approvedCommand(f, editorId)
  const transportMessages = [], sockets = []
  class ClientSocket extends WebSocket {
    constructor(url) {
      super('ws://' + new URL(f.address).host + new URL(url).pathname + new URL(url).search,
        { headers: { Origin: restrictedOrigin, Cookie: '__Host-dyoffice-session=' + f.alice.token } })
      f.sockets.add(this); sockets.push(this)
      this.on('message', raw => transportMessages.push(JSON.parse(raw.toString())))
    }
  }
  let received = 0
  const bridge = createEditorBridge({ origin: restrictedOrigin, fileId: f.aliceFile.fileId, editorId, WebSocketImpl: ClientSocket,
    fetchImpl: (path, init = {}) => fetch(f.address + new URL(path, restrictedOrigin).pathname, { ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + f.alice.token } }),
    onEvent: () => {}, commandTarget: {
      registration: () => ({ baseRevision: f.aliceFile.revision, editorGeneration: 3, leaseEpoch: 1, capabilities: [fixedTool.name] }),
      onCommand: (message, signal) => { assert.equal(signal.aborted, false); assert.deepEqual(message.envelope, command.envelope); received++; return true },
    },
  })
  t.after(() => bridge.dispose())
  const until = async predicate => { const end = Date.now() + 6000; while (!predicate() && Date.now() < end) await pause(10); assert.ok(predicate()) }
  await until(() => transportMessages.some(m => m.type === 'registered'))
  const registration = transportMessages.find(m => m.type === 'registered')
  assert.equal((await dispatch(f, registration, command)).status, 'delivered')
  assert.equal(received, 1)
  assert.equal((await dispatch(f, registration, command)).status, 'conflict')
  assert.equal(received, 1)
  const journal = await owned(f, f.alice.token, c => c.query('SELECT state FROM command_journal WHERE command_id=$1', [command.envelope.commandId]))
  assert.equal(journal.rows[0].state, 'unknown_outcome')
  bridge.dispose()
})

test('connection generations strictly increase locally and a new connection resets to one', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { pollIntervalMs: 1000 }), first = await open(f)
  for (let generation = 2; generation <= 6; generation++) {
    send(first, { type: 'sync' })
    assert.equal((await first.wait(m => m.type === 'state' && m.generation === generation)).headRevision, f.aliceFile.revision)
  }
  await disconnect(first)
  const back = await open(f)
  assert.equal(back.hello.generation, 1)
  assert.equal(back.hello.headRevision, f.aliceFile.revision)
})

test('live tickets are capped at 16 per owner across sessions and dead cleanup is bounded at 64', { timeout: 20_000 }, async t => {
  const f = await fixture(t), second = await f.sessions.login('alice', password)
  const issued = await Promise.all(Array.from({ length: 20 }, (_, i) => ticketFor(f, i % 2 ? f.alice.token : second.token)))
  assert.equal(issued.filter(r => r.status === 201).length, 16)
  assert.equal(issued.filter(r => r.status === 429).length, 4)
  assert.equal((await ticketFor(f, f.bob.token, f.bobFile.fileId)).status, 201)
  for (const session of [f.alice, second]) await owned(f, session.token, c =>
    c.query('UPDATE realtime_tickets SET used_at=clock_timestamp() WHERE session_id=$1', [session.sessionId]))
  await owned(f, f.alice.token, async c => {
    await c.query("INSERT INTO realtime_tickets(deployment_id,owner_id,session_id,file_id,ticket_hash,expires_at) SELECT $1,$2,$3,$4,lpad(to_hex(n),64,'0'),clock_timestamp()+interval '1 minute' FROM generate_series(1,80) n", [f.deploymentId, f.alice.user.id, f.alice.sessionId, f.aliceFile.fileId])
    await c.query('UPDATE realtime_tickets SET used_at=clock_timestamp() WHERE session_id=$1', [f.alice.sessionId])
  })
  assert.equal((await ticketFor(f)).status, 201)
  const left = await owned(f, f.alice.token, c => c.query('SELECT count(*)::integer AS n FROM realtime_tickets WHERE used_at IS NOT NULL'))
  assert.equal(left.rows[0].n, 32, '96 dead rows minus one bounded batch of 64')
})

test('one owner cannot retain more than eight simultaneous connections and a close releases capacity', { timeout: 20_000 }, async t => {
  const f = await fixture(t), connections = []
  for (let i = 0; i < 8; i++) connections.push(await open(f))
  const issued = await ticketFor(f)
  assert.equal(await rejectedUpgrade(f, { ticket: issued.body.ticket }), 429)
  await disconnect(connections.pop())
  const next = await open(f, { ticket: issued.body.ticket })
  assert.equal(next.hello.generation, 1, 'capacity rejection did not consume the ticket')
})

test('oversized frames and a blocked inbound flood disconnect only the offending connection', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { pollIntervalMs: 1000 }), healthy = await open(f), oversized = await open(f)
  oversized.ws.send('x'.repeat(16 * 1024 + 1))
  assert.equal(await deadline(oversized.closed), 1009)
  const flooded = await open(f)
  const lock = await f.ownerPool.connect()
  await lock.query('BEGIN')
  await lock.query('SELECT 1 FROM files WHERE id=$1 FOR UPDATE', [f.aliceFile.fileId])
  try {
    for (let i = 0; i < 40; i++) send(flooded, { type: 'sync' })
    await deadline(flooded.closed)
  } finally { await lock.query('ROLLBACK'); lock.release() }
  send(healthy, { type: 'ping' }); await healthy.wait(m => m.type === 'pong')
})

test('inbound queued bytes are bounded at 128KiB even below the 16-message cap', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { pollIntervalMs: 1000 }), flooded = await open(f)
  const lock = await f.ownerPool.connect()
  await lock.query('BEGIN'); await lock.query('SELECT 1 FROM files WHERE id=$1 FOR UPDATE', [f.aliceFile.fileId])
  try {
    for (let i = 0; i < 12; i++) flooded.ws.send(JSON.stringify({ type: 'invalid', text: 'x'.repeat(14 * 1024) }))
    await deadline(flooded.closed)
  } finally { await lock.query('ROLLBACK'); lock.release() }
})

test('pending upgrades are capped at eight and each handshake times out after five seconds', { timeout: 25_000 }, async t => {
  const f = await fixture(t), tickets = []
  for (let i = 0; i < 9; i++) tickets.push((await ticketFor(f)).body.ticket)
  const lock = await f.ownerPool.connect()
  await lock.query('BEGIN'); await lock.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [f.alice.user.id])
  const pending = []
  try {
    for (let i = 0; i < 8; i++) {
      const ws = new WebSocket('ws://' + new URL(f.address).host + '/realtime?ticket=' + tickets[i], { headers: { Origin: restrictedOrigin, Cookie: '__Host-dyoffice-session=' + f.alice.token } })
      f.sockets.add(ws); ws.on('error', () => {})
      pending.push({ ws, closed: new Promise(resolve => ws.once('close', resolve)) })
    }
    await waitForDatabaseLock(f, 'auth')
    // Wait until all eight TCP requests have entered the server upgrade handler.
    await pause(80)
    assert.equal(await rejectedUpgrade(f, { ticket: tickets[8] }), 503)
    await deadline(Promise.all(pending.map(p => p.closed)), 7000)
  } finally { await lock.query('ROLLBACK'); lock.release() }
})

test('two missed WebSocket pong opportunities terminate an idle peer', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 80 }), connection = await open(f, { autoPong: false })
  let pings = 0; connection.ws.on('ping', () => pings++)
  await deadline(connection.closed)
  assert.equal(pings, 2)
})

test('malformed raw upgrade URLs are rejected and app preClose terminates live WS before HTTP shutdown', { timeout: 20_000 }, async t => {
  const f = await fixture(t), port = new URL(f.address).port
  const raw = connectTcp({ host: '127.0.0.1', port: Number(port) })
  const received = new Promise(resolve => raw.once('data', data => resolve(data.toString())))
  await once(raw, 'connect')
  raw.write('GET http://[invalid/realtime HTTP/1.1\r\nHost: office.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
  assert.match(await deadline(received), /^HTTP\/1.1 400/)
  raw.destroy()
  const connection = await open(f)
  await deadline(f.app.close(), 3000)
  await deadline(connection.closed)
})
