import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer, request as httpsRequest } from 'node:https'
import WebSocket from 'ws'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { password } from '../helpers/identity.mjs'
import { createSessionFileHost } from '../../../../packages/browser-host/src/session-files.ts'
import { createEditorBridge } from '../../../../packages/browser-host/src/editor-bridge.ts'

async function until(predicate) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.fail('TLS realtime condition did not settle')
}

test('TLS session login, WSS reconnect and HTTP commit retain exact revision authority', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-realtime-tls-'))
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' })
  let f, bridge, host
  const sockets = []
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => f.app.routing(req, res))
  server.on('upgrade', (req, socket, head) => f.app.server.emit('upgrade', req, socket, head))
  t.after(async () => {
    bridge?.dispose(); host?.dispose()
    for (const socket of sockets) socket.terminate()
    await f?.app.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'https://127.0.0.1:' + server.address().port
  f = await fileFixture(t, { origin })
  const imported = await importFile(f, f.alice.token, await docxBytes(), 'tls-realtime.docx')
  const fileId = imported.file.fileId, editorId = randomUUID(), ca = await readFile(cert)
  let cookie = ''
  const calls = []
  const fetchImpl = async (path, init = {}) => {
    const target = new URL(path, origin)
    assert.equal(target.origin, origin)
    calls.push(target.pathname)
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers))
      const req = httpsRequest(target, { method: init.method ?? 'GET', ca, headers: { ...headers, origin, ...(cookie ? { cookie } : {}) }, signal: init.signal }, res => {
        const chunks = []; let size = 0
        res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { req.destroy(Error('Test response limit')); return }; chunks.push(chunk) })
        res.on('end', () => {
          const cookies = res.headers['set-cookie']
          if (cookies) cookie = cookies.filter(value => !/(?:^|;)\s*Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(res.headers)) if (value !== undefined && name !== 'set-cookie') responseHeaders.set(name, Array.isArray(value) ? value.join(',') : value)
          resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }))
        })
      })
      req.on('error', reject)
      if (init.body) req.write(init.body)
      req.end()
    })
  }
  const challenge = await (await fetchImpl('/api/v1/auth/csrf')).json()
  const login = await fetchImpl('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken }, body: JSON.stringify({ username: 'alice', password }) })
  assert.equal(login.status, 200)
  assert.ok(cookie.includes('__Host-dyoffice-session='))
  class SecureSocket extends WebSocket {
    constructor(url) { assert.ok(url.startsWith('wss://')); super(url, { ca, headers: { origin, cookie } }); sockets.push(this) }
  }
  host = createSessionFileHost({ fetchImpl, editorId })
  await host.open(fileId); await host.acquireLease(fileId)
  const events = [], reconciled = []
  const options = { origin, fileId, editorId, fetchImpl, WebSocketImpl: SecureSocket, initialBackoffMs: 20, maxBackoffMs: 80,
    onEvent: message => events.push(message), pendingCommandIds: () => [randomUUID()], onReconcile: message => reconciled.push(message) }
  bridge = createEditorBridge(options)
  await until(() => bridge.getStatus() === 'open' && reconciled.length === 1)
  assert.equal(bridge.getHeadRevision(), imported.file.revision)
  assert.equal(reconciled[0].commands[0].state, null)
  sockets[0].terminate()
  await until(() => sockets.length >= 2 && bridge.getStatus() === 'open')
  assert.equal(events.filter(event => event.type === 'state')[1].generation, 1)
  bridge.dispose()
  const receipt = await host.save(fileId, new Uint8Array(await docxBytes()))
  assert.notEqual(receipt.revision, imported.file.revision)
  bridge = createEditorBridge(options)
  await until(() => bridge.getStatus() === 'open')
  assert.equal(bridge.getHeadRevision(), receipt.revision)
  assert.equal(calls.filter(path => path.endsWith('/commits')).length, 1, 'reconnection never replays an HTTP write')
  const head = await (await fetchImpl('/api/v1/files/' + fileId)).json()
  assert.equal(head.file.revision, receipt.revision)
})
