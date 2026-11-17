import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createBoundedSourceSocket } from '../../server/src/modules/sources/wire-budget.ts'

test('SQL wire budget stops an oversized frame before driver parsing and ignores driver dial arguments', async t => {
  let accepted = 0
  const server = createServer(socket => { accepted++; socket.on('error', () => {}); socket.end(Buffer.alloc(200_000, 65)) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => server.close(r)))
  const socket = createBoundedSourceSocket({ address: '127.0.0.1', port: server.address().port, family: 4 }, 100_000)
  let bytes = 0
  socket.on('data', chunk => { bytes += chunk.length })
  const error = new Promise(r => socket.once('error', r))
  // The driver-supplied host/port can never replace the approved numeric pin.
  socket.connect(1, '169.254.169.254')
  assert.equal((await error).message, 'Source response limit exceeded')
  assert.ok(bytes <= 100_000)
  assert.equal(accepted, 1)
})
