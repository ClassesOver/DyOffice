import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { restrictedFixture, restrictedOrigin } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { buildLocalApp } from '../../server/src/app.ts'

const keys = () => 'k1:' + randomBytes(32).toString('base64')
async function start(t, handler) {
  const s = createServer(handler)
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  t.after(() => { s.closeAllConnections(); return new Promise(r => s.close(r)) })
  return 'http://127.0.0.1:' + s.address().port + '/data'
}
async function fixture(t, url) {
  const credentialKeys = keys(), f = await restrictedFixture(t, { sourcesCredentialKeys: credentialKeys })
  await f.app.close()
  f.app = await buildLocalApp({ db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin: restrictedOrigin, csrfKey: f.csrfKey, sourcesCredentialKeys: credentialKeys, sourcesEgressTargets: [{ kind: 'http', endpoint: url, addresses: ['127.0.0.1'], allowInsecure: true }] })
  f.cleanup.push(() => f.app.close())
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  f.request = (method, path, payload, token = f.alice.token, headers = {}) => f.app.inject({ method, url: '/api/v1/sources' + path, payload, headers: { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token), ...headers } })
  f.call = async (method, path, payload, status = 200) => { const r = await f.request(method, path, payload); assert.equal(r.statusCode, status, method + ' ' + path + ' ' + r.body); return r.json() }
  await f.call('POST', '', { sourceId: 'a', name: 'A', kind: 'http', config: {}, secret: url }, 201)
  return f
}

test('draft test, explicit clear, retain, disable, idempotent publish and concurrent CAS', async t => {
  const url = await start(t, (_q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end('{"rows":[{"v":1}]}'))
  const f = await fixture(t, url)
  await f.call('POST', '/a/query', {}, 409)
  assert.equal((await f.call('POST', '/a/test', {})).ok, true)
  const pub = await f.call('POST', '/a/publish', { expectedVersion: 1 })
  const again = await f.call('POST', '/a/publish', { expectedVersion: 1 })
  assert.deepEqual(again, pub)
  // Empty secret never accidentally clears; null has an explicit meaning.
  await f.call('PUT', '/a', { expectedVersion: 1, secret: '' }, 400)
  await f.call('PUT', '/a', { expectedVersion: 1, secret: null })
  let detail = await f.call('GET', '/a')
  assert.equal(detail.source.hasCredential, false)
  assert.equal(detail.source.hasUnpublishedChanges, true)
  assert.equal((await f.call('POST', '/a/test', {})).ok, false)
  await f.call('POST', '/a/publish', { expectedVersion: 2 }, 409)
  // Clearing only the draft does not rewrite a published credential or evidence.
  assert.equal((await f.call('POST', '/a/query', {})).rows[0].v, 1)
  await f.call('PUT', '/a', { expectedVersion: 2, secret: url })
  const outcomes = await Promise.all([f.request('PUT', '/a', { expectedVersion: 3, name: 'Writer 1' }), f.request('PUT', '/a', { expectedVersion: 3, name: 'Writer 2' })])
  assert.deepEqual(outcomes.map(r => r.statusCode).sort(), [200, 409])
  detail = await f.call('GET', '/a')
  assert.equal(detail.source.version, 4)
  assert.equal(detail.source.hasCredential, true)
  assert.equal(JSON.stringify(detail).includes(url), false)
  await f.call('PUT', '/a', { expectedVersion: 4, enabled: false })
  await f.call('POST', '/a/query', {}, 409)
  await f.call('POST', '/a/test', {}, 409)
  await f.call('POST', '/a/publish', { expectedVersion: 5 })
  assert.equal((await f.call('GET', '/a')).source.enabled, false)
  await f.call('PUT', '/a', { expectedVersion: 5, enabled: true })
  assert.equal((await f.call('POST', '/a/query', {})).rows[0].v, 1)
  const del = await f.request('DELETE', '/a', { expectedVersion: 6 })
  assert.equal(del.statusCode, 204)
  await f.call('GET', '/a', undefined, 404)
})

test('in-flight HTTP result is withheld after source disable or session revocation', async t => {
  let respond, entered
  const started = () => new Promise(r => { entered = r })
  const url = await start(t, (_q, r) => { respond = () => r.writeHead(200, { 'content-type': 'application/json' }).end('{"rows":[{"v":"private-revoked-query-value"}]}'); entered?.() })
  const f = await fixture(t, url)
  await f.call('POST', '/a/publish', { expectedVersion: 1 })
  let gate = started(), pending = f.request('POST', '/a/query', {})
  await gate
  await f.call('PUT', '/a', { expectedVersion: 1, enabled: false })
  respond()
  assert.equal((await pending).statusCode, 409)
  await f.call('PUT', '/a', { expectedVersion: 2, enabled: true })
  gate = started(); pending = f.request('POST', '/a/query', {})
  await gate
  await f.sessions.logout(f.alice.token)
  respond()
  const denied = await pending
  assert.equal(denied.statusCode, 401)
  assert.equal(denied.body.includes('private-revoked-query-value'), false)
})

test('DELETE validates CAS and preserves the newer publication before permanently reserving the source ID', async t => {
  const url = await start(t, (_q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end('{"rows":[{"v":7}]}'))
  const f = await fixture(t, url)
  await f.call('POST', '/a/publish', { expectedVersion: 1 })
  await f.call('PUT', '/a', { expectedVersion: 1, name: 'New publication' })
  const publication = await f.call('POST', '/a/publish', { expectedVersion: 2 })
  assert.equal(publication.revision, 2)
  for (const payload of [undefined, {}, { expectedVersion: 0 }, { expectedVersion: '2' }, { expectedVersion: 2, force: true }]) {
    assert.equal((await f.request('DELETE', '/a', payload)).statusCode, 400)
  }
  assert.equal((await f.request('DELETE', '/a', { expectedVersion: 1 })).statusCode, 409)
  const intact = await f.call('GET', '/a')
  assert.equal(intact.source.version, 2)
  assert.deepEqual(intact.published, publication)
  assert.equal((await f.call('POST', '/a/query', {})).sourceVersion, 2)
  assert.equal((await f.request('DELETE', '/a', { expectedVersion: 2 })).statusCode, 204)
  assert.deepEqual(await f.call('GET', ''), { items: [], nextCursor: null })
  await f.call('GET', '/a', undefined, 404)
  await f.call('POST', '', { sourceId: 'a', name: 'Replacement', kind: 'http', config: {}, secret: url }, 409)
  await f.call('PUT', '/a', { expectedVersion: 1, name: 'Old writer' }, 404)
  await f.call('POST', '/a/publish', { expectedVersion: 1 }, 404)
  await f.call('POST', '/a/test', {}, 404)
  await f.call('POST', '/a/query', {}, 404)
  assert.equal((await f.request('DELETE', '/a', { expectedVersion: 2 })).statusCode, 404)
  const tombstone = await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, async (c, principal) => (await c.query('SELECT deleted_at,enabled FROM data_sources WHERE deployment_id=$1 AND owner_id=$2 AND source_id=$3', [principal.deploymentId, principal.userId, 'a'])).rows)
  assert.equal(tombstone.length, 1)
  assert.ok(tombstone[0].deleted_at)
  assert.equal(tombstone[0].enabled, false)
  await assert.rejects(f.businessPool.query("DELETE FROM data_sources WHERE source_id='a'"), { code: '42501' })
})

for (const operation of ['test','query']) test(`in-flight ${operation} refuses an HTTP result after deletion and same-ID recreation attempt`, async t => {
  let release, entered
  const received = new Promise(resolve => { entered = resolve })
  const url = await start(t, (_q, r) => { release = () => r.writeHead(200, { 'content-type': 'application/json' }).end('{"rows":[{"v":"old-instance-data"}]}'); entered() })
  const f = await fixture(t, url)
  await f.call('POST', '/a/publish', { expectedVersion: 1 })
  const pending = f.request('POST', '/a/' + operation, {})
  await received
  assert.equal((await f.request('DELETE', '/a', { expectedVersion: 1 })).statusCode, 204)
  await f.call('POST', '', { sourceId: 'a', name: 'Replacement', kind: 'http', config: {}, secret: url }, 409)
  release()
  const denied = await pending
  assert.equal(denied.statusCode, 404)
  assert.equal(denied.body.includes('old-instance-data'), false)
  assert.equal(denied.body.includes('"ok":true'), false)
})

test('RLS and least privileges independently isolate drafts, publications and vault', async t => {
  const url = await start(t, (_q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end('{"rows":[{"v":1}]}'))
  const f = await fixture(t, url)
  await f.call('POST', '/a/publish', { expectedVersion: 1 })
  const tables = ['data_sources','data_source_drafts','data_source_versions','data_source_credentials']
  const c = await f.businessPool.connect()
  try {
    await c.query('BEGIN')
    for (const table of tables) assert.equal((await c.query('SELECT * FROM ' + table)).rowCount, 0)
    await c.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)", [f.deploymentId, f.bob.user.id])
    for (const table of tables) assert.equal((await c.query('SELECT * FROM ' + table)).rowCount, 0)
    await c.query('ROLLBACK')
    for (const table of ['data_source_versions','data_source_credentials','data_source_audit']) {
      const denial = await c.query('UPDATE ' + table + ' SET source_id=source_id').catch(e => e)
      assert.equal(denial.code, '42501')
    }
  } finally { c.release() }
  for (const pool of [f.authPool]) for (const table of tables) {
    const denial = await pool.query('SELECT * FROM ' + table).catch(e => e)
    assert.equal(denial.code, '42501')
  }
  const denied = await f.request('POST', '/a/test', {}, f.bob.token)
  assert.equal(denied.statusCode, 404)
  const csrfDenied = await f.request('PUT', '/a', { expectedVersion: 1, name: 'csrf' }, f.alice.token, { 'x-csrf-token': 'bad' })
  assert.equal(csrfDenied.statusCode, 403)
})
