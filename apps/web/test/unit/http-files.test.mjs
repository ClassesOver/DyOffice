import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createHttpFileHost } from '../../../../packages/browser-host/src/http-files.ts'
import { serveReadOnlyFiles } from '../../server/readonly-files.mjs'

test('HttpFileHost reads exact revisioned bytes but never exposes save or editable features', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-http-host-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const id = randomUUID()
  const document = Buffer.from('%PDF-1.7 exact')
  await writeFile(join(directory, id), document)
  const state = { files: [{ id, name:'document.pdf', format:'pdf', size:document.length }] }
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer personal') {res.writeHead(401);res.end();return}
    if (req.url === '/api/preferences') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({theme:'light',language:'zh',apiKey:'secret'}));return}
    const ok = await serveReadOnlyFiles(req,res,{url:new URL(req.url,'http://localhost'),state,filePath:directory})
    if(!ok) {res.writeHead(404);res.end()}
  })
  server.listen(0,'127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}`
  const httpFetch = (path,init) => fetch(base+path,init)
  const host = createHttpFileHost({fetchImpl:httpFetch,getAuthHeaders:()=>({Authorization:'Bearer personal'})})
  assert.deepEqual(await host.getCapabilities(), { docx:'unsupported',xlsx:'unsupported',pptx:'unsupported',pdf:'unsupported' })
  const opened=await host.open(id)
  assert.equal(opened.file.fileId,id)
  assert.equal(opened.format,'pdf')
  assert.equal(opened.capabilities.pdf,'unsupported')
  assert.equal(Buffer.from(await host.readBytes(id,opened.file.revision)).compare(document),0)
  await assert.rejects(host.readBytes(id,'sha256:'+'0'.repeat(64)),e=>e.code==='CONFLICT')
  await assert.rejects(host.stageSave(new Uint8Array([1]),id),e=>e.code==='UNSUPPORTED')
  assert.deepEqual(await host.getPreferences(),{theme:'light',language:'zh'})
  const forbidden = createHttpFileHost({fetchImpl:httpFetch})
  await assert.rejects(forbidden.open(id),e=>e.code==='UNAUTHORIZED')
})

test('HttpFileHost rejects corrupted bytes even if proxy reports success', async () => {
  const id = randomUUID()
  const expected = 'sha256:' + '0'.repeat(64)
  const host = createHttpFileHost({
    fetchImpl: async () => new Response('%PDF-different', {status:200,headers:{'content-type':'application/octet-stream'}}),
  })
  await assert.rejects(host.readBytes(id,expected),e=>e.code==='INVALID_RESPONSE')
})
