import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication } from '../server/application.mjs'

test('versioned file reads retain personal-token boundaries and legacy download compatibility', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-v1-read-'))
  const server = await createApplication({ directory, userToken:'personal', adminToken:'admin', encryptionKey:'integration-test-key' })
  server.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory,{recursive:true,force:true}) })
  const base = `http://127.0.0.1:${server.address().port}`
  const bytes = Buffer.from('%PDF-1.7 integration')
  const upload = await fetch(base + '/api/files', { method:'POST', headers:{ Authorization:'Bearer personal', 'X-File-Name':encodeURIComponent('integration.pdf') }, body:bytes })
  assert.equal(upload.status, 201)
  const { id } = await upload.json()
  const path = `/api/v1/files/${id}`
  assert.equal((await fetch(base + path)).status, 401)
  assert.equal((await fetch(base + path, {headers:{Authorization:'Bearer admin'}})).status, 403)
  const userHeaders = {Authorization:'Bearer personal'}
  const infoResult = await fetch(base + path, {headers:userHeaders})
  assert.equal(infoResult.status,200)
  const info = await infoResult.json()
  assert.equal(info.file.fileId,id)
  assert.match(info.file.sha256,/^[a-f0-9]{64}$/)
  assert.equal(info.capabilities.pdf,'unsupported')
  const versioned = await fetch(base + info.downloadEndpoint+'?revision='+encodeURIComponent(info.file.revision),{headers:userHeaders})
  assert.equal(versioned.status,200)
  assert.equal(Buffer.from(await versioned.arrayBuffer()).compare(bytes),0)
  assert.equal((await fetch(base+info.downloadEndpoint+'?revision=outdated',{headers:userHeaders})).status,409)
  assert.equal((await fetch(base+info.downloadEndpoint+'?revision='+encodeURIComponent(info.file.revision),{headers:{Authorization:'Bearer admin'}})).status,403)
  const old = await fetch(base+'/api/files/'+id,{headers:userHeaders})
  assert.equal(old.status,200)
  assert.equal(Buffer.from(await old.arrayBuffer()).compare(bytes),0)
  assert.equal((await fetch(base+'/api/v1/capabilities',{headers:{Authorization:'Bearer admin'}})).status,403)
  assert.equal((await fetch(base+path,{method:'PUT',headers:userHeaders})).status,405)
})
