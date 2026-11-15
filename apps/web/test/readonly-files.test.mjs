import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { serveReadOnlyFiles } from '../server/readonly-files.mjs'

test('read-only file bridge provides immutable metadata and exact content without accepting writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-readonly-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const id = randomUUID()
  const bytes = Buffer.from('%PDF-1.7 sample')
  const digest = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(directory, id), bytes)
  const state = { files: [{ id, format: 'pdf', name: '中文.pdf', size: bytes.length }] }
  const server = createServer(async (req, res) => {
    const handled = await serveReadOnlyFiles(req, res, { url: new URL(req.url, 'http://localhost'), state, filePath: directory })
    if (!handled) { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const metadata = await fetch(`${base}/api/v1/files/${id}`)
  assert.equal(metadata.status, 200)
  const info = await metadata.json()
  assert.deepEqual(info.file, { fileId: id, revision: `sha256:${digest}`, sha256: digest, size: bytes.length })
  assert.equal(info.capabilities.pdf, 'unsupported')
  assert.equal(info.downloadEndpoint, `/api/v1/files/${id}/content`)
  const bytesResponse = await fetch(base + info.downloadEndpoint + '?revision=' + encodeURIComponent(info.file.revision))
  assert.equal(bytesResponse.status, 200)
  assert.equal(Buffer.from(await bytesResponse.arrayBuffer()).compare(bytes), 0)
  assert.equal(bytesResponse.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(base + info.downloadEndpoint)).status, 400)
  assert.equal((await fetch(base + info.downloadEndpoint + '?revision=stale')).status, 409)
  await writeFile(join(directory, id), Buffer.from('%PDF-1.7 changed'))
  assert.equal((await fetch(base + info.downloadEndpoint + '?revision=' + encodeURIComponent(info.file.revision))).status, 409)
  assert.equal((await fetch(`${base}/api/v1/files/${id}`, { method: 'PUT' })).status, 405)
  assert.equal((await fetch(`${base}/api/v1/files/${randomUUID()}`)).status, 404)
  assert.equal((await fetch(`${base}/api/v1/capabilities`).then(r=>r.json())).docx, 'unsupported')
})
