import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication } from '../server/application.mjs'

test('API authorization rejects a large body before it is buffered', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-early-auth-'))
  const server = await createApplication({
    directory,
    userToken: 'personal',
    adminToken: 'admin',
    encryptionKey: 'test-only-encryption-key',
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const port = server.address().port

  async function deniedStatus(headers) {
    return await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: '/api/preferences',
        headers: {
          'content-type': 'application/json',
          'content-length': String(8 * 1024 * 1024),
          ...headers,
        },
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
      })
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error('authorization waited for the request body'))
      }, 1000)
      req.on('error', () => {})
      req.on('close', () => clearTimeout(timer))
      req.write('{"theme":"dark"')
    })
  }

  const anonymous = await deniedStatus()
  assert.equal(anonymous.status, 401)
  assert.equal(JSON.parse(anonymous.body).error, '请登录')
  const wrongRole = await deniedStatus({ authorization: 'Bearer admin' })
  assert.equal(wrongRole.status, 403)
  assert.equal(JSON.parse(wrongRole.body).error, '需要个人工作区权限')

  const saved = await fetch(`http://127.0.0.1:${port}/api/preferences`, {
    method: 'PUT',
    headers: { authorization: 'Bearer personal', 'content-type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' }),
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).theme, 'dark')
  const health = await fetch(`http://127.0.0.1:${port}/api/v1/health/live`)
  assert.equal(health.status, 200)
})
