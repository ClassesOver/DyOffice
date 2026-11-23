import {assertDisposableSourceDatabase} from '../helpers/disposable-source-database.mjs'
// Real disposable PostgreSQL + pinned local HTTP integration for personal source tools.
// Only the query tool may contact the connector; all later reads use frozen JSONB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { restrictedFixture, restrictedOrigin } from '../helpers/restricted.mjs'
import { password } from '../helpers/identity.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'

const workspacePath = '/api/v1/workspace'
const toolNames = ['sources.list', 'sources.describe', 'sources.query', 'sources.save_result', 'sources.read_result']
const timezone = 'Asia/Shanghai'
const units = { zz_amount: 'CNY', a_time: 'ISO8601' }
const schema = [
  { name: 'zz_amount', type: 'number', unit: 'CNY' },
  { name: 'a_time', type: 'string', unit: 'ISO8601' },
  { name: 'flag', type: 'boolean' },
  { name: 'literal', type: 'string' },
]
const digest = value => createHash('sha256').update(value).digest('hex')
const rows = (count, label = 'Alice') => Array.from({ length: count }, (_, i) => ({
  zz_amount: i === 1 ? null : i + 0.5,
  a_time: '2026-11-17T01:02:03.000Z',
  flag: i % 2 === 0,
  literal: i === 0 ? '=SUM(A1:A2)' : label + ' ' + i,
}))

async function fixture(t, datasets = { alice: rows(1203) }) {
  assertDisposableSourceDatabase(process.env.DYOFFICE_TEST_DATABASE_URL)
  const bodies = new Map(Object.entries(datasets).map(([name, data]) => [name, JSON.stringify({ payload: { rows: data } })]))
  const requests = []
  const server = createServer((request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
    requests.push({ name, method: request.method, cookie: request.headers.cookie, authorization: request.headers.authorization })
    const body = bodies.get(name)
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body ?? '{}') })
    response.end(body ?? '{}')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const origin = 'http://127.0.0.1:' + server.address().port
  const endpoint = name => origin + '/' + name + '?api_key=fixture-only-private-' + name
  const f = await restrictedFixture(t, {
    businessMax: 8,
    sourcesCredentialKeys: 'k1:' + randomBytes(32).toString('base64'),
    sourcesEgressTargets: [...bodies.keys()].map(name => ({ kind: 'http', endpoint: endpoint(name), addresses: ['127.0.0.1'], allowInsecure: true })),
  })
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  f.http = { origin, endpoint, requests, count: name => requests.filter(request => request.name === name).length, replace: (name, data) => bodies.set(name, JSON.stringify({ payload: { rows: data } })) }
  f.csrf = csrf
  f.request = (method, path, payload, { token = f.alice.token, headers = {} } = {}) => {
    const combined = {
      origin: restrictedOrigin,
      ...(token === null ? {} : { cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token) }),
      ...headers,
    }
    return f.app.inject({ method, url: path, ...(payload === undefined ? {} : { payload }), headers: Object.fromEntries(Object.entries(combined).filter(([, value]) => value !== undefined)) })
  }
  f.call = async (method, path, payload, { status = 200, ...options } = {}) => {
    const response = await f.request(method, path, payload, options)
    assert.equal(response.statusCode, status, method + ' ' + path + ' ' + response.body)
    assert.equal(response.headers['cache-control'], status >= 400 ? 'no-store' : 'private, no-store')
    return status === 204 ? undefined : response.json()
  }
  f.execute = (name, args = {}, options = {}) => f.call('POST', workspacePath + '/source-tools/execute', { name, arguments: args }, options)
  f.home = (query = '', options = {}) => f.call('GET', workspacePath + '/data-results' + query, undefined, options)
  f.page = (resultId, query = '', options = {}) => f.call('GET', workspacePath + '/data-results/' + resultId + query, undefined, options)
  f.createSource = async ({ sourceId = 'metrics', name = 'Personal metrics', endpointName = 'alice', config = {}, token = f.alice.token } = {}) => {
    const created = await f.call('POST', '/api/v1/sources', {
      sourceId, name, kind: 'http', config: { timezone, rowPath: 'payload.rows', units, ...config }, secret: endpoint(endpointName),
    }, { token, status: 201 })
    return created
  }
  f.counts = async (token = f.alice.token) => {
    const scoped = await f.transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => ({
      ownerId: principal.userId,
      artifacts: (await connection.query('SELECT state,count(*)::integer AS count FROM workspace_source_results GROUP BY state ORDER BY state')).rows,
    }))
    // Audit is append-only for the runtime role; use the existing migration-owner
    // fixture only to observe scoped counts, never to grant connector privileges.
    const connection = await f.ownerPool.connect()
    try {
      await connection.query('BEGIN')
      await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true)", [f.deploymentId, scoped.ownerId])
      const queries = (await connection.query("SELECT count(*)::integer AS count FROM data_source_audit WHERE deployment_id=$1 AND owner_id=$2 AND action='source_queried'", [f.deploymentId, scoped.ownerId])).rows[0].count
      await connection.query('COMMIT')
      return { artifacts: scoped.artifacts, queries }
    } catch (error) { await connection.query('ROLLBACK'); throw error } finally { connection.release() }
  }
  return f
}

function noSecrets(value, f) {
  const text = JSON.stringify(value)
  for (const secret of [f.http.origin, 'fixture-only-private-', 'postgresql://', 'ciphertext', 'credential_ref']) assert.equal(text.includes(secret), false, 'Response leaked ' + secret)
}

async function download(f, resultId, token = f.alice.token) {
  const response = await f.request('GET', workspacePath + '/data-results/' + resultId + '/content', undefined, { token })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(response.headers['content-type'], /^application\/json; charset=utf-8$/)
  assert.match(response.headers['content-disposition'], /^attachment; /)
  assert.equal(response.headers['cache-control'], 'private, no-store')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['content-security-policy'], "sandbox; default-src 'none'")
  const snapshot = JSON.parse(response.body)
  const { sha256, ...evidence } = snapshot
  assert.equal(digest(JSON.stringify(evidence)), sha256, 'Downloaded canonical evidence must reproduce its snapshot hash')
  return { response, snapshot }
}

test('tool definitions expose the five bounded tools with no caller-selectable owner, workspace or DSN', async t => {
  const f = await fixture(t)
  const definitions = await f.call('GET', workspacePath + '/source-tools')
  assert.deepEqual(definitions.tools.map(tool => tool.name), toolNames)
  for (const tool of definitions.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    for (const forbidden of ['ownerId', 'workspaceId', 'dsn', 'secret', 'connectionString']) assert.equal(Object.hasOwn(tool.inputSchema.properties, forbidden), false)
  }
  const read = definitions.tools.find(tool => tool.name === 'sources.read_result').inputSchema
  assert.equal(read.properties.limit.maximum, 1000)
  assert.deepEqual(definitions.tools.find(tool => tool.name === 'sources.save_result').inputSchema.required, ['resultId', 'name', 'commandId'])
  noSecrets(definitions, f)
  assert.equal(f.http.requests.length, 0)
})

test('sources.list exposes only the cookie owner enabled saved connections, excluding missing credentials, disabled and deleted sources', async t => {
  const f = await fixture(t, { alice: rows(2), bob: rows(3, 'Bob') })
  await f.createSource({ sourceId: 'a-enabled' })
  await f.createSource({ sourceId: 'b-empty' })
  await f.call('PUT', '/api/v1/sources/b-empty', { expectedVersion: 1, secret: null })
  await f.createSource({ sourceId: 'c-disabled' })
  await f.call('PUT', '/api/v1/sources/c-disabled', { expectedVersion: 1, enabled: false })
  await f.createSource({ sourceId: 'd-deleted' })
  await f.call('DELETE', '/api/v1/sources/d-deleted', { expectedVersion: 1 }, { status: 204 })
  await f.createSource({ sourceId: 'z-enabled' })
  await f.createSource({ sourceId: 'bob-only', name: 'Bob private source', endpointName: 'bob', token: f.bob.token })
  const listed = await f.execute('sources.list')
  assert.deepEqual(listed, { items: [
    { sourceId: 'a-enabled', name: 'Personal metrics', kind: 'http', sourceVersion: 1 },
    { sourceId: 'z-enabled', name: 'Personal metrics', kind: 'http', sourceVersion: 1 },
  ], nextCursor: null })
  assert.deepEqual(await f.execute('sources.list', { after: 'a-enabled' }), { items: [listed.items[1]], nextCursor: null })
  assert.deepEqual((await f.execute('sources.list', {}, { token: f.bob.token })).items.map(item => item.sourceId), ['bob-only'])
  for (const sourceId of ['c-disabled']) {
    await f.execute('sources.describe', { sourceId }, { status: 409 })
    await f.execute('sources.query', { sourceId }, { status: 409 })
  }
  await f.execute('sources.query', { sourceId: 'b-empty' }, { status: 503 })
  await f.execute('sources.describe', { sourceId: 'd-deleted' }, { status: 404 })
  await f.execute('sources.query', { sourceId: 'd-deleted' }, { status: 404 })
  noSecrets(listed, f)
  assert.equal(f.http.requests.length, 0)
})

test('sources.list filters unavailable connections before paging without empty leading pages',async t=>{
 const f=await fixture(t,{alice:rows(1)})
 for(let i=0;i<51;i++){
  const sourceId='hidden-'+String(i).padStart(2,'0')
  await f.createSource({sourceId})
  await f.call('PUT','/api/v1/sources/'+sourceId,{expectedVersion:1,enabled:false})
 }
 await f.createSource({sourceId:'visible'})
 const listed=await f.execute('sources.list')
 assert.deepEqual(listed.items.map(item=>item.sourceId),['visible'])
 assert.equal(listed.nextCursor,null)
 assert.equal(f.http.requests.length,0)
})

test('HTTP describe returns current saved extraction metadata and units without revealing or fetching the credential', async t => {
  const f = await fixture(t)
  await f.createSource()
  await f.call('PUT', '/api/v1/sources/metrics', { expectedVersion: 1, config: { timezone: 'UTC', rowPath: 'draft.rows', units: { zz_amount: 'USD' } } })
  const described = await f.execute('sources.describe', { sourceId: 'metrics' })
  assert.deepEqual(described, {
    sourceId: 'metrics', sourceVersion: 2, kind: 'http',
    config: { timezone:'UTC', maxRows: 1000, rowPath: 'draft.rows', units: {zz_amount:'USD'} }, metadata: null,
  })
  noSecrets(described, f)
  assert.equal(f.http.requests.length, 0)
  assert.deepEqual(await f.counts(), { artifacts: [], queries: 0 })
})

test('query freezes 1000 rows with a 100-row preview; save retries, Home, paging and canonical JSON download never query again', async t => {
  const original = rows(1203), frozenRows = original.slice(0, 1000)
  const f = await fixture(t, { alice: original })
  await f.createSource()
  const queried = await f.execute('sources.query', { sourceId: 'metrics' })
  const artifact = queried.artifact
  assert.match(artifact.resultId, /^[a-f0-9-]{36}$/)
  assert.equal(artifact.state, 'pending')
  assert.equal(artifact.sourceId, 'metrics')
  assert.equal(artifact.sourceVersion, 1)
  assert.equal(artifact.name, null)
  assert.equal(artifact.savedAt, null)
  assert.ok(Date.parse(artifact.expiresAt) > Date.now())
  assert.match(artifact.queryHash, /^[a-f0-9]{64}$/)
  assert.equal(artifact.rowCount, 1000)
  assert.equal(artifact.truncated, true)
  assert.ok(artifact.sizeBytes <= 1_000_000)
  assert.equal(queried.totalRows, 1000)
  assert.equal(queried.sourceTruncated, true)
  assert.equal(queried.nextOffset, 100)
  assert.equal(queried.timezone, timezone)
  assert.deepEqual(queried.schema, schema)
  assert.deepEqual(queried.preview, frozenRows.slice(0, 100))
  assert.equal(queried.sha256, artifact.sha256)
  assert.match(queried.notice, /truncat/i)
  const expectedEvidence = { version: 1, sourceId: 'metrics', sourceVersion: 1, schema, timezone, rows: frozenRows, truncated: true }
  assert.equal(queried.sha256, digest(JSON.stringify(expectedEvidence)))
  const workspace = await f.transactions.withPrincipalTransaction({ kind: 'session', token: f.alice.token }, async connection => (await connection.query('SELECT id FROM workspaces')).rows)
  assert.equal(workspace.length, 1)
  assert.equal(artifact.workspaceId, workspace[0].id)
  assert.deepEqual(await f.home(), { items: [], nextCursor: null }, 'Pending capture must not appear on Home')
  assert.deepEqual(await f.counts(), { artifacts: [{ state: 'pending', count: 1 }], queries: 1 })
  const pendingPage = await f.execute('sources.read_result', { resultId: artifact.resultId, offset: 100, limit: 123 })
  assert.deepEqual(pendingPage.rows, frozenRows.slice(100, 223))
  assert.equal(pendingPage.nextOffset, 223)

  // Mutating the fixture makes any accidental connector replay observable in both data and counts.
  f.http.replace('alice', rows(1, 'Changed after capture'))
  const command = { resultId: artifact.resultId, name: '个人指标', commandId: randomUUID() }
  const saved = await f.execute('sources.save_result', command)
  assert.equal(saved.resultId, artifact.resultId)
  assert.equal(saved.workspaceId, artifact.workspaceId)
  assert.equal(saved.state, 'saved')
  assert.equal(saved.name, command.name)
  assert.equal(saved.expiresAt, null)
  assert.ok(saved.savedAt)
  assert.equal(saved.sha256, artifact.sha256)
  assert.equal(saved.sizeBytes, artifact.sizeBytes)
  const retried = await Promise.all(Array.from({ length: 4 }, () => f.execute('sources.save_result', command)))
  for (const receipt of retried) assert.deepEqual(receipt, saved)
  await f.execute('sources.save_result', { ...command, name: 'Changed retry' }, { status: 409 })
  await f.execute('sources.save_result', { ...command, commandId: randomUUID() }, { status: 409 })
  assert.deepEqual(await f.home(), { items: [saved], nextCursor: null })

  const defaultPage = await f.execute('sources.read_result', { resultId: saved.resultId })
  assert.equal(defaultPage.rows.length, 1000)
  assert.equal(defaultPage.nextOffset, null)
  const captured = []
  let offset = 0
  do {
    const page = await f.page(saved.resultId, '?offset=' + offset + '&limit=333')
    assert.deepEqual(page.artifact, saved)
    assert.deepEqual(page.schema, schema)
    assert.equal(page.timezone, timezone)
    assert.equal(page.offset, offset)
    assert.equal(page.totalRows, 1000)
    assert.equal(page.sourceTruncated, true)
    assert.equal(page.sha256, artifact.sha256)
    assert.equal(page.nextOffset, offset + page.rows.length < 1000 ? offset + page.rows.length : null)
    captured.push(...page.rows)
    offset = page.nextOffset
  } while (offset !== null)
  assert.deepEqual(captured, frozenRows)
  const end = await f.page(saved.resultId, '?offset=1000&limit=10')
  assert.deepEqual(end.rows, [])
  assert.equal(end.nextOffset, null)
  const { response, snapshot } = await download(f, saved.resultId)
  assert.match(response.headers['content-disposition'], new RegExp("filename\\*=UTF-8''" + encodeURIComponent(command.name + '.json')))
  assert.deepEqual(snapshot, { ...expectedEvidence, sha256: artifact.sha256 })
  assert.equal(response.rawPayload.length, artifact.sizeBytes)
  assert.equal(response.body, JSON.stringify(snapshot), 'Download must preserve canonical property order after JSONB storage')
  assert.equal(snapshot.rows[0].literal, '=SUM(A1:A2)')
  assert.equal(snapshot.rows[1].zz_amount, null)
  noSecrets({ queried, saved, defaultPage, snapshot }, f)
  assert.deepEqual(await f.counts(), { artifacts: [{ state: 'saved', count: 1 }], queries: 1 })
  assert.equal(f.http.requests.length, 1, 'Exactly one HTTP query for capture + all save retries/pages/downloads')
  assert.deepEqual(f.http.requests[0], { name: 'alice', method: 'GET', cookie: undefined, authorization: undefined })
})

test('Home list parses an HTTP string limit and pages saved results without duplicates or connector replay', async t => {
  const f = await fixture(t, { alice: rows(2) })
  await f.createSource()
  const saved = []
  for (const name of ['First result', 'Second result']) {
    const query = await f.execute('sources.query', { sourceId: 'metrics' })
    saved.push(await f.execute('sources.save_result', { resultId: query.artifact.resultId, name, commandId: randomUUID() }))
  }
  const seen = []
  let after
  do {
    const page = await f.home('?limit=1' + (after ? '&after=' + encodeURIComponent(after) : ''))
    assert.equal(page.items.length, 1)
    seen.push(page.items[0].resultId)
    after = page.nextCursor
    assert.ok(seen.length <= saved.length, 'Home cursor must make progress')
  } while (after !== null)
  assert.deepEqual(seen, saved.map(item => item.resultId).sort())
  for (const value of ['0', '101', '-1', '1.5', '1e1', 'NaN', '']) await f.home('?limit=' + value, { status: 400 })
  assert.equal(f.http.requests.length, 2)
})

test('Bob and Admin guesses of another owner source or pending/saved result return 404 before any connector I/O', async t => {
  const data = rows(3)
  data[0].literal = 'alice-private-captured-value'
  const f = await fixture(t, { alice: data })
  await f.createSource({ sourceId: 'alice-private' })
  const query = await f.execute('sources.query', { sourceId: 'alice-private' })
  const resultId = query.artifact.resultId
  const command = { resultId, name: 'Alice private result', commandId: randomUUID() }
  for (const state of ['pending', 'saved']) {
    if (state === 'saved') await f.execute('sources.save_result', command)
    for (const token of [f.bob.token, f.adminSigned.token]) {
      for (const [name, args] of [
        ['sources.describe', { sourceId: 'alice-private' }],
        ['sources.query', { sourceId: 'alice-private' }],
        ['sources.read_result', { resultId }],
        ['sources.save_result', command],
      ]) {
        const denied = await f.execute(name, args, { token, status: 404 })
        assert.equal(JSON.stringify(denied).includes('alice-private-captured-value'), false)
        assert.equal(JSON.stringify(denied).includes(query.sha256), false)
      }
      await f.page(resultId, '', { token, status: 404 })
      const content = await f.request('GET', workspacePath + '/data-results/' + resultId + '/content', undefined, { token })
      assert.equal(content.statusCode, 404, content.body)
      assert.equal(content.body.includes('alice-private-captured-value'), false)
    }
    assert.deepEqual(await f.execute('sources.list', {}, { token: f.bob.token }), { items: [], nextCursor: null })
    assert.deepEqual(await f.home('', { token: f.bob.token }), { items: [], nextCursor: null })
    assert.equal(f.http.requests.length, 1, 'A guessed source/result must never contact Alice connector')
  }
  assert.deepEqual(await f.counts(), { artifacts: [{ state: 'saved', count: 1 }], queries: 1 })
})

test('identical source IDs, names and save command IDs remain isolated in each owner personal workspace', async t => {
  const aliceRows = rows(3), bobRows = rows(5, 'Bob')
  const f = await fixture(t, { alice: aliceRows, bob: bobRows })
  await f.createSource({ name: 'Shared source name' })
  await f.createSource({ name: 'Shared source name', endpointName: 'bob', token: f.bob.token, config: { units: { zz_amount: 'USD', a_time: 'ISO8601' } } })
  const alice = await f.execute('sources.query', { sourceId: 'metrics' })
  const bob = await f.execute('sources.query', { sourceId: 'metrics' }, { token: f.bob.token })
  assert.notEqual(alice.artifact.resultId, bob.artifact.resultId)
  assert.notEqual(alice.artifact.workspaceId, bob.artifact.workspaceId)
  assert.notEqual(alice.sha256, bob.sha256)
  assert.deepEqual(alice.preview, aliceRows)
  assert.deepEqual(bob.preview, bobRows)
  assert.equal(bob.schema[0].unit, 'USD')
  const commandId = randomUUID(), name = 'Shared result name'
  const savedAlice = await f.execute('sources.save_result', { resultId: alice.artifact.resultId, name, commandId })
  const savedBob = await f.execute('sources.save_result', { resultId: bob.artifact.resultId, name, commandId }, { token: f.bob.token })
  assert.deepEqual((await f.home()).items, [savedAlice])
  assert.deepEqual((await f.home('', { token: f.bob.token })).items, [savedBob])
  assert.deepEqual((await f.page(savedAlice.resultId)).rows, aliceRows)
  assert.deepEqual((await f.page(savedBob.resultId, '', { token: f.bob.token })).rows, bobRows)
  for (const [token, foreign] of [[f.alice.token, savedBob], [f.bob.token, savedAlice], [f.adminSigned.token, savedAlice]]) {
    await f.execute('sources.read_result', { resultId: foreign.resultId }, { token, status: 404 })
    await f.execute('sources.save_result', { resultId: foreign.resultId, name, commandId }, { token, status: 404 })
    await f.page(foreign.resultId, '', { token, status: 404 })
  }
  assert.equal(f.http.count('alice'), 1)
  assert.equal(f.http.count('bob'), 1)
  assert.deepEqual(await f.counts(), { artifacts: [{ state: 'saved', count: 1 }], queries: 1 })
  assert.deepEqual(await f.counts(f.bob.token), { artifacts: [{ state: 'saved', count: 1 }], queries: 1 })
})

test('definitions, tools and result routes require a live cookie session; execute also enforces CSRF and same origin', async t => {
  const f = await fixture(t, { alice: rows(2) })
  await f.createSource()
  const query = await f.execute('sources.query', { sourceId: 'metrics' })
  const saved = await f.execute('sources.save_result', { resultId: query.artifact.resultId, name: 'Protected', commandId: randomUUID() })
  const paths = [workspacePath + '/source-tools', workspacePath + '/data-results', workspacePath + '/data-results/' + saved.resultId, workspacePath + '/data-results/' + saved.resultId + '/content']
  for (const path of paths) await f.call('GET', path, undefined, { token: null, status: 401 })
  // The write hook rejects anonymous calls at the CSRF gate before authenticating.
  await f.execute('sources.list', {}, { token: null, status: 403 })
  const unknown = randomBytes(32).toString('base64url')
  await f.execute('sources.list', {}, { token: unknown, status: 401 })
  for (const headers of [
    { 'x-csrf-token': undefined },
    { 'x-csrf-token': 'bad' },
    { 'x-csrf-token': f.csrf.sessionToken(f.bob.token) },
    { origin: undefined },
    { origin: 'https://other.example' },
    { 'sec-fetch-site': 'cross-site' },
  ]) await f.execute('sources.query', { sourceId: 'metrics' }, { headers, status: 403 })
  for (const path of paths) await f.call('GET', path, undefined, { headers: { origin: 'https://other.example' }, status: 403 })
  await f.execute('sources.list', {}, { headers: { authorization: 'Bearer ' + f.alice.token, cookie: undefined }, status: 401 })
  await f.sessions.logout(f.alice.token)
  for (const path of paths) await f.call('GET', path, undefined, { status: 401 })
  await f.execute('sources.read_result', { resultId: saved.resultId }, { status: 401 })
  await f.execute('sources.save_result', { resultId: saved.resultId, name: 'Protected', commandId: randomUUID() }, { status: 401 })
  assert.equal(f.http.requests.length, 1)
})

test('every tool rejects owner/workspace/DSN injection in arguments and envelope without querying or saving', async t => {
  const f = await fixture(t, { alice: rows(2) })
  await f.createSource()
  const query = await f.execute('sources.query', { sourceId: 'metrics' })
  const resultId = query.artifact.resultId
  const calls = [
    ['sources.list', {}],
    ['sources.describe', { sourceId: 'metrics' }],
    ['sources.query', { sourceId: 'metrics' }],
    ['sources.save_result', { resultId, name: 'Must not save', commandId: randomUUID() }],
    ['sources.read_result', { resultId }],
  ]
  for (const [field, value] of [
    ['ownerId', f.bob.user.id], ['workspaceId', randomUUID()],
    ['dsn', 'postgresql://fixture:never-connect@127.0.0.1:55433/dyoffice_test'],
    ['secret', f.http.endpoint('alice')], ['connectionString', f.http.endpoint('alice')],
  ]) for (const [name, args] of calls) {
    await f.execute(name, { ...args, [field]: value }, { status: 400 })
    await f.call('POST', workspacePath + '/source-tools/execute', { name, arguments: args, [field]: value }, { status: 400 })
  }
  await f.home('?ownerId=' + f.bob.user.id, { status: 400 })
  await f.page(resultId, '?workspaceId=' + randomUUID(), { status: 400 })
  await f.call('GET', workspacePath + '/data-results/' + resultId + '/content?ownerId=' + f.bob.user.id, undefined, { status: 400 })
  await f.execute('sources.read_result', { resultId, limit: '1' }, { status: 400 })
  await f.execute('sources.read_result', { resultId, limit: 1001 }, { status: 400 })
  await f.execute('sources.read_result', { resultId, offset: -1 }, { status: 400 })
  assert.deepEqual(await f.home(), { items: [], nextCursor: null })
  assert.deepEqual(await f.counts(), { artifacts: [{ state: 'pending', count: 1 }], queries: 1 })
  assert.equal(f.http.requests.length, 1)
})

test('disabled pending evidence cannot be saved, while an already saved result survives source disable and deletion', async t => {
  const original = rows(4)
  const f = await fixture(t, { alice: original })
  await f.createSource()
  const kept = await f.execute('sources.query', { sourceId: 'metrics' })
  const saved = await f.execute('sources.save_result', { resultId: kept.artifact.resultId, name: 'Keep after deletion', commandId: randomUUID() })
  const pending = await f.execute('sources.query', { sourceId: 'metrics' })
  const unsavedCommand = { resultId: pending.artifact.resultId, name: 'Disabled pending', commandId: randomUUID() }
  await f.call('PUT', '/api/v1/sources/metrics', { expectedVersion: 1, enabled: false })
  await f.execute('sources.save_result', unsavedCommand, { status: 409 })
  await f.execute('sources.read_result', { resultId: pending.artifact.resultId }, { status: 409 })
  await f.page(pending.artifact.resultId, '', { status: 409 })
  await f.execute('sources.describe', { sourceId: 'metrics' }, { status: 409 })
  await f.execute('sources.query', { sourceId: 'metrics' }, { status: 409 })
  assert.deepEqual((await f.execute('sources.read_result', { resultId: saved.resultId })).rows, original)
  await f.call('DELETE', '/api/v1/sources/metrics', { expectedVersion: 2 }, { status: 204 })
  await f.execute('sources.describe', { sourceId: 'metrics' }, { status: 404 })
  await f.execute('sources.query', { sourceId: 'metrics' }, { status: 404 })
  await f.execute('sources.save_result', unsavedCommand, { status: 404 })
  assert.deepEqual(await f.execute('sources.list'), { items: [], nextCursor: null })
  assert.deepEqual((await f.home()).items, [saved])
  assert.deepEqual((await f.execute('sources.read_result', { resultId: saved.resultId })).rows, original)
  assert.deepEqual((await f.page(saved.resultId)).rows, original)
  const { snapshot } = await download(f, saved.resultId)
  assert.deepEqual(snapshot.rows, original)
  assert.deepEqual(snapshot.schema, schema)
  assert.equal(snapshot.timezone, timezone)
  assert.equal(snapshot.sha256, saved.sha256)
  assert.equal(f.http.requests.length, 2)
  assert.deepEqual(await f.counts(), { artifacts: [{ state: 'pending', count: 1 }, { state: 'saved', count: 1 }], queries: 2 })
})

test('pending results are session-bound; saved results and the same save receipt remain available to another owner login', async t => {
  const f = await fixture(t, { alice: rows(3) })
  await f.createSource()
  const pending = await f.execute('sources.query', { sourceId: 'metrics' })
  const query = await f.execute('sources.query', { sourceId: 'metrics' })
  const command = { resultId: query.artifact.resultId, name: 'Across owner sessions', commandId: randomUUID() }
  const saved = await f.execute('sources.save_result', command)
  const nextLogin = await f.sessions.login('alice', password)
  await f.execute('sources.read_result', { resultId: pending.artifact.resultId }, { token: nextLogin.token, status: 404 })
  await f.execute('sources.save_result', { resultId: pending.artifact.resultId, name: 'Another session', commandId: randomUUID() }, { token: nextLogin.token, status: 404 })
  await f.page(pending.artifact.resultId, '', { token: nextLogin.token, status: 404 })
  assert.deepEqual(await f.execute('sources.save_result', command, { token: nextLogin.token }), saved)
  assert.deepEqual((await f.home('', { token: nextLogin.token })).items, [saved])
  await f.sessions.logout(f.alice.token)
  await f.execute('sources.read_result', { resultId: saved.resultId }, { status: 401 })
  assert.deepEqual((await f.execute('sources.read_result', { resultId: saved.resultId }, { token: nextLogin.token })).rows, rows(3))
  assert.deepEqual((await download(f, saved.resultId, nextLogin.token)).snapshot.rows, rows(3))
  assert.equal(f.http.requests.length, 2)
})

test('HTTP source refuses responses beyond its fixed 1 MB budget without persisting an artifact or success query audit', async t => {
  const oversized = rows(1)
  oversized[0].literal = 'x'.repeat(1_000_001)
  const f = await fixture(t, { alice: oversized })
  await f.createSource()
  const denied = await f.execute('sources.query', { sourceId: 'metrics' }, { status: 502 })
  assert.equal(JSON.stringify(denied).includes('x'.repeat(100)), false)
  assert.deepEqual(await f.counts(), { artifacts: [], queries: 0 })
  assert.deepEqual(await f.home(), { items: [], nextCursor: null })
  assert.equal(f.http.requests.length, 1)
})
