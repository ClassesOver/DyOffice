import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { assertRuntimePool } from '../../server/src/db/roles.ts'
import { restrictedFixture, restrictedOrigin } from '../helpers/restricted.mjs'

const cwd = fileURLToPath(new URL('../../', import.meta.url))
const environment = f => ({ ...process.env, NODE_ENV: 'development', DYOFFICE_FILE_API: '', DYOFFICE_OBJECT_STORE: '', DYOFFICE_AUTH_MODE: 'local', DYOFFICE_DATABASE_URL: '', DYOFFICE_AUTH_DATABASE_URL: f.urls.auth, DYOFFICE_BUSINESS_DATABASE_URL: f.urls.business, DYOFFICE_DEPLOYMENT_ID: f.deploymentId, DYOFFICE_ORIGIN: restrictedOrigin, DYOFFICE_CSRF_KEY: f.csrfKey, DYOFFICE_USER_TOKEN: '', DYOFFICE_ADMIN_TOKEN: '', PORT: '0', HOST: '127.0.0.1' })

test('local server entry uses separate restricted credentials and serves scoped preferences', { timeout: 15_000 }, async t => {
  const f = await restrictedFixture(t)
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], { cwd, env: environment(f), stdio: ['ignore','pipe','pipe'] })
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } })
  const exited = once(child, 'exit')
  const [output] = await Promise.race([once(child.stdout, 'data'), exited.then(([code]) => { throw new Error('Scoped entry exited before startup: ' + code) })])
  const address = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(address)
  const response = await fetch(address + '/api/v1/preferences', { headers: { cookie: '__Host-dyoffice-session=' + f.alice.token } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).theme, 'system')
  child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null])
})

test('local entry refuses a migration URL instead of falling back to the owner connection', async t => {
  const f = await restrictedFixture(t)
  await assert.rejects(promisify(execFile)(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], { cwd, env: { ...environment(f), DYOFFICE_DATABASE_URL: f.urls.owner }, timeout: 2500 }), error => {
    assert.equal(error.code, 1)
    assert.equal(error.stderr.includes(f.urls.owner), false)
    return true
  })
})


test('runtime provisioning CLI is idempotent with a separate nonsuperuser owner', async t => {
  const f = await restrictedFixture(t)
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', 'tools/dyoffice/provision-runtime.ts'], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    env: { ...process.env, DYOFFICE_DATABASE_URL: f.urls.owner, DYOFFICE_AUTH_ROLE: f.names.auth, DYOFFICE_BUSINESS_ROLE: f.names.business }, timeout: 5000,
  })
  assert.match(stdout, /Runtime database grants installed/)
  for (const url of Object.values(f.urls)) assert.equal((stdout + stderr).includes(new URL(url).password), false)
  await assertRuntimePool(f.authPool, 'auth')
  await assertRuntimePool(f.businessPool, 'business')
})

for (const backend of ['local-dev','s3']) test(`actual local server enables scoped file import with explicit experimental ${backend} storage`, { timeout: 15_000 }, async t => {
  const { fileFixture, docxBytes } = await import('../helpers/files.mjs')
  const { createCsrfService } = await import('../../server/src/modules/auth/csrf.ts')
  const f = await fileFixture(t), bytes = await docxBytes()
  const storage = { DYOFFICE_FILE_API: 'experimental', DYOFFICE_OBJECT_STORE: backend, DYOFFICE_OBJECT_DIRECTORY: f.directory }
  if (backend === 's3') {
    const { s3Fixture } = await import('../helpers/s3.mjs')
    const remote = await s3Fixture(t)
    Object.assign(storage, { DYOFFICE_S3_ENDPOINT: process.env.DYOFFICE_TEST_S3_ENDPOINT, DYOFFICE_S3_REGION: 'us-east-1', DYOFFICE_S3_BUCKET: remote.bucket, DYOFFICE_S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: process.env.DYOFFICE_TEST_S3_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: process.env.DYOFFICE_TEST_S3_SECRET_KEY })
  }
  const env = { ...environment(f), ...storage }
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], { cwd, env, stdio: ['ignore','pipe','pipe'] })
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child,'exit') } })
  const exited = once(child,'exit')
  const [output] = await Promise.race([once(child.stdout,'data'),exited.then(([code]) => { throw new Error('File server startup failed: ' + code) })])
  const address = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  assert.ok(address)
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  const headers = { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + f.alice.token, 'x-csrf-token': csrf.sessionToken(f.alice.token) }
  const staged = await fetch(address + '/api/v1/files/uploads', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'entry.docx', size: bytes.length }) })
  assert.equal(staged.status,201)
  const upload = await staged.json(), base = address + '/api/v1/uploads/' + upload.uploadId
  assert.equal((await fetch(base + '/content', { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes })).status,200)
  const finished = await fetch(base + '/finish', { method: 'POST', headers })
  assert.equal(finished.status,200)
  const opened = await finished.json()
  assert.deepEqual(Buffer.from(await (await fetch(address + opened.downloadEndpoint, { headers })).arrayBuffer()), bytes)
  child.kill('SIGTERM'); assert.deepEqual(await exited,[0,null])
})
