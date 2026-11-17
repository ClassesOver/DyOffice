// Test-only PostgreSQL/TLS relay for disposable loopback clusters. Never accepts
// a remote address or credentials. COMMIT is cut only after the backend emits
// its real CommandComplete(COMMIT), not after a timer or simulated client error.
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import {once} from 'node:events'

const sslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])

export async function commitCutProxy({port, ca, key, cert}) {
  const sockets = new Set(), errors = []
  const observed = {connections: 0, upstreamTls: 0, commitCommands: 0, cutConfirmations: 0}
  const context = tls.createSecureContext({key, cert})
  const track = socket => {
    sockets.add(socket)
    socket.on('error', error => errors.push(error))
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  async function upstream() {
    const socket = track(net.connect({host: '127.0.0.1', port}))
    await once(socket, 'connect')
    const accepted = once(socket, 'data')
    socket.write(sslRequest)
    const [reply] = await accepted
    assert.deepEqual(reply, Buffer.from('S'))
    const secure = track(tls.connect({socket, ca, servername: 'localhost', rejectUnauthorized: true}))
    await once(secure, 'secureConnect')
    assert.equal(secure.authorized, true)
    observed.upstreamTls++
    return secure
  }
  const server = net.createServer(socket => {
    track(socket)
    observed.connections++
    let header = Buffer.alloc(0)
    const initial = chunk => {
      header = Buffer.concat([header, chunk])
      if (header.length < 8) return
      socket.removeListener('data', initial)
      if (!header.equals(sslRequest)) { errors.push(Error('Expected isolated PG SSLRequest')); socket.destroy(); return }
      socket.write('S')
      const client = track(new tls.TLSSocket(socket, {isServer: true, secureContext: context}))
      client.pause()
      void upstream().then(backend => {
        let pending = Buffer.alloc(0), cut = false
        client.on('data', chunk => backend.write(chunk))
        client.once('close', () => backend.destroy())
        backend.once('close', () => client.destroy())
        backend.on('data', chunk => {
          if (cut) return
          pending = Buffer.concat([pending, chunk])
          while (pending.length >= 5) {
            const length = pending.readUInt32BE(1)
            if (length < 4 || length > 1024 * 1024) {
              errors.push(Error('Unexpected backend frame size')); backend.destroy(); client.destroy(); return
            }
            if (pending.length < length + 1) break
            const frame = pending.subarray(0, length + 1)
            pending = pending.subarray(length + 1)
            if (frame[0] === 0x43 && frame.subarray(5).equals(Buffer.from('COMMIT\0'))) {
              observed.commitCommands++
              observed.cutConfirmations++
              cut = true
              // No COMMIT confirmation bytes or following ReadyForQuery bytes
              // reach the client. PostgreSQL already executed COMMIT.
              backend.destroy()
              client.destroy()
              return
            }
            client.write(frame)
          }
        })
        client.resume()
      }).catch(error => { errors.push(error); client.destroy() })
    }
    socket.on('data', initial)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    observed,
    errors,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
