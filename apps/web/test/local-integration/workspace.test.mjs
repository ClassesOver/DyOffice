import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileFixture, docxBytes, importFile } from '../helpers/files.mjs'
import { restrictedOrigin, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { assertRuntimePool } from '../../server/src/db/roles.ts'

const base = '/api/v1/workspace'
const credential = token => ({ kind: 'session', token })
const own = (f, callback, token = f.alice.token) => f.transactions.withPrincipalTransaction(credential(token), callback)
function request(f, method, path, payload, token = f.alice.token, headers = {}) {
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  return f.app.inject({ method, url: base + path, payload, headers: { origin: restrictedOrigin, cookie: '__Host-dyoffice-session=' + token, 'x-csrf-token': csrf.sessionToken(token), ...headers } })
}
async function list(f, query = '', token = f.alice.token) {
  const response = await request(f, 'GET', '/files' + query, undefined, token)
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function folder(f, name, parentId = null, token = f.alice.token) {
  const response = await request(f, 'POST', '/folders', { name, parentId }, token)
  assert.equal(response.statusCode, 201, response.body)
  return response.json()
}
async function mutate(f, method, path, payload, status = 204, token = f.alice.token) {
  const response = await request(f, method, path, payload, token)
  assert.equal(response.statusCode, status, response.body)
  return response
}
async function imported(f, name = 'report.docx', token = f.alice.token) {
  return (await importFile(f, token, await docxBytes(), name)).file.fileId
}

test('workspace lists persisted files with bounded pagination without inventing recent opens', async t => {
  const f = await fileFixture(t)
  assert.deepEqual(await list(f), { files: [], total: 0 })
  const first = await imported(f, 'first.docx'), second = await imported(f, 'second.docx')
  const listing = await list(f)
  assert.equal(listing.total, 2)
  assert.deepEqual(new Set(listing.files.map(file => file.id)), new Set([first, second]))
  for (const file of listing.files) {
    assert.deepEqual(Object.keys(file).sort(), ['folderId','format','id','lastOpenedAt','name','size','starred','updatedAt'].sort())
    assert.equal(file.starred, false); assert.equal(file.folderId, null); assert.equal(file.lastOpenedAt, null)
    assert.ok(file.size > 0); assert.equal(file.format, 'docx'); assert.ok(Number.isFinite(Date.parse(file.updatedAt)))
  }
  assert.deepEqual(await list(f, '?view=recent'), { files: [], total: 0 })
  assert.deepEqual(await list(f, '?view=starred'), { files: [], total: 0 })
  const page = await list(f, '?limit=1&offset=1')
  assert.equal(page.total, 2); assert.equal(page.files.length, 1)
  assert.equal(page.files[0].id, listing.files[1].id)
  assert.deepEqual(await list(f, '?limit=1&offset=2'), { files: [], total: 2 })
  assert.match((await request(f, 'GET', '/files')).headers['cache-control'], /no-store/)
})

test('folder create rename move and delete persist a deterministic tree and reject duplicate siblings or cycles', async t => {
  const f = await fileFixture(t)
  const parent = await folder(f, '  Projects  '), other = await folder(f, 'Archive')
  assert.equal(parent.name, 'Projects'); assert.equal(parent.parentId, null)
  const child = await folder(f, 'Drafts', parent.id)
  await mutate(f, 'POST', '/folders', { name: 'projects', parentId: null }, 409)
  await mutate(f, 'POST', '/folders', { name: 'Drafts', parentId: parent.id }, 409)
  await folder(f, 'Drafts', other.id)
  await mutate(f, 'PATCH', '/folders/' + parent.id, { parentId: child.id }, 409)
  await mutate(f, 'PATCH', '/folders/' + parent.id, { parentId: parent.id }, 409)
  await mutate(f, 'DELETE', '/folders/' + parent.id, undefined, 409)
  const renamed = (await mutate(f, 'PATCH', '/folders/' + child.id, { name: 'Final', parentId: other.id }, 200)).json()
  assert.equal(renamed.name, 'Final'); assert.equal(renamed.parentId, other.id)
  await mutate(f, 'DELETE', '/folders/' + parent.id)
  const response = await request(f, 'GET', '/folders')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().folders.map(row => row.name), ['Archive','Drafts','Final'])
  assert.deepEqual(Object.keys(response.json().folders[0]).sort(), ['createdAt','id','name','parentId','updatedAt'].sort())
  const { createWorkspaceService } = await import('../../server/src/modules/workspace/service.ts')
  assert.deepEqual(await createWorkspaceService(f.transactions).listFolders(f.alice.token), response.json())
  await mutate(f, 'DELETE', '/folders/' + child.id)
  await mutate(f, 'DELETE', '/folders/' + child.id, undefined, 404)
})

test('file moves persist membership and root filtering while nonempty folders cannot be deleted', async t => {
  const f = await fileFixture(t), id = await imported(f), box = await folder(f, 'Invoices')
  await mutate(f, 'PATCH', '/files/' + id + '/folder', { folderId: box.id })
  assert.equal((await list(f)).files[0].folderId, box.id)
  assert.deepEqual(await list(f, '?folderId=root'), { files: [], total: 0 })
  assert.equal((await list(f, '?folderId=' + box.id)).files[0].id, id)
  await mutate(f, 'DELETE', '/folders/' + box.id, undefined, 409)
  await mutate(f, 'PATCH', '/files/' + id + '/folder', { folderId: null })
  assert.equal((await list(f, '?folderId=root')).files[0].folderId, null)
  assert.deepEqual(await list(f, '?folderId=' + box.id), { files: [], total: 0 })
  await mutate(f, 'DELETE', '/folders/' + box.id)
})

test('stars and real opening timestamps survive service recreation and removing recent never removes a file', async t => {
  const f = await fileFixture(t), first = await imported(f, 'first.docx'), second = await imported(f, 'second.docx')
  await mutate(f, 'PUT', '/files/' + first + '/star', { starred: true })
  assert.deepEqual((await list(f, '?view=starred')).files.map(row => row.id), [first])
  assert.equal((await list(f, '?view=recent')).total, 0)
  const before = (await f.ownerPool.query('SELECT clock_timestamp() AS now')).rows[0].now.valueOf()
  await mutate(f, 'POST', '/files/' + first + '/open')
  await mutate(f, 'POST', '/files/' + second + '/open')
  await mutate(f, 'POST', '/files/' + first + '/open')
  const recent = await list(f, '?view=recent')
  const after = (await f.ownerPool.query('SELECT clock_timestamp() AS now')).rows[0].now.valueOf()
  assert.equal(recent.total, 2); assert.deepEqual(recent.files.map(row => row.id), [first, second])
  assert.ok(recent.files.every(row => Date.parse(row.lastOpenedAt) >= before && Date.parse(row.lastOpenedAt) <= after))
  const { createWorkspaceService } = await import('../../server/src/modules/workspace/service.ts')
  assert.deepEqual(await createWorkspaceService(f.transactions).listFiles(f.alice.token, { view: 'recent' }), recent)
  await mutate(f, 'DELETE', '/files/' + first + '/recent')
  await mutate(f, 'DELETE', '/files/' + first + '/recent')
  assert.deepEqual((await list(f, '?view=recent')).files.map(row => row.id), [second])
  assert.equal((await list(f)).total, 2)
  assert.equal((await list(f, '?view=starred')).files[0].id, first)
  await mutate(f, 'PUT', '/files/' + first + '/star', { starred: false })
  assert.equal((await list(f, '?view=starred')).total, 0)
})

test('concurrent star open and folder writes preserve each independent field', async t => {
  const f = await fileFixture(t), id = await imported(f), box = await folder(f, 'Parallel')
  await Promise.all([
    mutate(f, 'PUT', '/files/' + id + '/star', { starred: true }),
    mutate(f, 'POST', '/files/' + id + '/open'),
    mutate(f, 'PATCH', '/files/' + id + '/folder', { folderId: box.id }),
  ])
  const file = (await list(f, '?view=recent&folderId=' + box.id)).files[0]
  assert.equal(file.id, id); assert.equal(file.starred, true); assert.equal(file.folderId, box.id)
  assert.ok(Number.isFinite(Date.parse(file.lastOpenedAt)))
})

test('trash hides workspace activity but restore retains folder stars and opening history', async t => {
  const f = await fileFixture(t), id = await imported(f), box = await folder(f, 'Keep')
  await mutate(f, 'PATCH', '/files/' + id + '/folder', { folderId: box.id })
  await mutate(f, 'PUT', '/files/' + id + '/star', { starred: true })
  await mutate(f, 'POST', '/files/' + id + '/open')
  const saved = (await list(f)).files[0]
  await f.files.trashFile(f.alice.token, id)
  for (const view of ['all','recent','starred']) assert.deepEqual(await list(f, '?view=' + view), { files: [], total: 0 })
  const trashed = (await list(f, '?view=trash')).files[0]
  assert.equal(trashed.folderId, box.id); assert.equal(trashed.starred, true); assert.equal(trashed.lastOpenedAt, saved.lastOpenedAt)
  for (const [method, path, body] of [['PUT','/star',{ starred: false }],['POST','/open'],['DELETE','/recent'],['PATCH','/folder',{ folderId: null }]]) await mutate(f, method, '/files/' + id + path, body, 404)
  await mutate(f, 'DELETE', '/folders/' + box.id, undefined, 409)
  await f.files.restoreFile(f.alice.token, id)
  const restored = (await list(f, '?view=recent&folderId=' + box.id)).files[0]
  assert.equal(restored.id, id); assert.equal(restored.starred, true); assert.equal(restored.lastOpenedAt, saved.lastOpenedAt)
  assert.equal((await list(f, '?view=trash')).total, 0)
})

test('A B and config administrators cannot read or mutate one another workspace resources', async t => {
  const f = await fileFixture(t), id = await imported(f), box = await folder(f, 'Private')
  await mutate(f, 'PUT', '/files/' + id + '/star', { starred: true })
  await mutate(f, 'POST', '/files/' + id + '/open')
  for (const token of [f.bob.token, f.adminSigned.token]) {
    for (const view of ['all','recent','starred','trash']) assert.deepEqual(await list(f, '?view=' + view, token), { files: [], total: 0 })
    assert.deepEqual((await request(f, 'GET', '/folders', undefined, token)).json(), { folders: [] })
    assert.equal((await request(f, 'GET', '/files?folderId=' + box.id, undefined, token)).statusCode, 404)
    for (const [method, path, body] of [['PUT','/files/' + id + '/star',{ starred: false }],['POST','/files/' + id + '/open'],['DELETE','/files/' + id + '/recent'],['PATCH','/files/' + id + '/folder',{ folderId: null }],['POST','/folders',{ name: 'Intrusion', parentId: box.id }],['PATCH','/folders/' + box.id,{ name: 'Intrusion' }],['DELETE','/folders/' + box.id]]) await mutate(f, method, path, body, 404, token)
  }
  const bFolder = await folder(f, 'Other', null, f.bob.token)
  await mutate(f, 'PATCH', '/files/' + id + '/folder', { folderId: bFolder.id }, 404)
  await mutate(f, 'PATCH', '/folders/' + box.id, { parentId: bFolder.id }, 404)
  assert.equal((await list(f, '?view=starred')).files[0].id, id)
})

test('workspace rejects authority injection malformed inputs and unsafe folder names', async t => {
  const f = await fileFixture(t), id = await imported(f), box = await folder(f, 'Valid')
  for (const query of ['view=unknown','view=all&view=trash','folderId=null','folderId=root%27%20OR%201=1--','folderId=../root','limit=0','limit=101','offset=-1','offset=1.5','ownerId=' + f.bob.user.id,'deploymentId=' + randomUUID()]) assert.equal((await request(f, 'GET', '/files?' + query)).statusCode, 400, query)
  assert.equal((await request(f, 'GET', '/files?folderId=' + randomUUID())).statusCode, 404)
  assert.equal((await request(f, 'GET', '/folders?ownerId=' + f.bob.user.id)).statusCode, 400)
  for (const name of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(101)]) await mutate(f, 'POST', '/folders', { name, parentId: null }, 400)
  for (const body of [{ name: 'Hidden', parentId: null, ownerId: f.bob.user.id }, { name: 'Hidden', parentId: 'root' }, { parentId: null }]) await mutate(f, 'POST', '/folders', body, 400)
  for (const body of [{}, { name: '' }, { ownerId: f.bob.user.id }, { parentId: 'root' }]) await mutate(f, 'PATCH', '/folders/' + box.id, body, 400)
  for (const body of [{ starred: 'true' }, { starred: true, ownerId: f.bob.user.id }, {}]) await mutate(f, 'PUT', '/files/' + id + '/star', body, 400)
  for (const body of [{ folderId: 'root' }, { folderId: null, ownerId: f.bob.user.id }, {}]) await mutate(f, 'PATCH', '/files/' + id + '/folder', body, 400)
  await mutate(f, 'POST', '/files/' + id + '/open', { lastOpenedAt: '2099-01-01T00:00:00Z' }, 400)
  await mutate(f, 'DELETE', '/files/' + id + '/recent', { ownerId: f.bob.user.id }, 400)
})

test('workspace HTTP requires its current cookie session and mutation CSRF', async t => {
  const f = await fileFixture(t), id = await imported(f)
  assert.equal((await f.app.inject({ method: 'GET', url: base + '/files' })).statusCode, 401)
  assert.equal((await request(f, 'GET', '/files', undefined, f.alice.token, { authorization: 'Bearer ignored' })).statusCode, 401)
  assert.equal((await request(f, 'GET', '/files', undefined, f.alice.token, { origin: 'https://evil.example' })).statusCode, 403)
  assert.equal((await request(f, 'PUT', '/files/' + id + '/star', { starred: true }, f.alice.token, { 'x-csrf-token': '' })).statusCode, 403)
  assert.equal((await request(f, 'POST', '/folders', { name: 'Rejected', parentId: null }, f.alice.token, { origin: 'https://evil.example' })).statusCode, 403)
  await f.sessions.logout(f.alice.token)
  assert.equal((await request(f, 'GET', '/files')).statusCode, 401)
  assert.equal((await request(f, 'POST', '/files/' + id + '/open')).statusCode, 401)
})

test('personal workspace tables force RLS composite ownership and least privilege at SQL boundary', async t => {
  const f = await fileFixture(t, { worker: true }), id = await imported(f), other = await imported(f, 'other.docx', f.bob.token)
  const box = await folder(f, 'Alice'), bFolder = await folder(f, 'Bob', null, f.bob.token)
  await mutate(f, 'PATCH', '/files/' + id + '/folder', { folderId: box.id })
  for (const table of ['workspace_folders','workspace_file_state']) {
    assert.equal((await f.businessPool.query('SELECT * FROM ' + table)).rowCount, 0)
    assert.equal((await f.ownerPool.query('SELECT * FROM ' + table)).rowCount, 0)
    for (const pool of [f.authPool, f.workerPool]) await assert.rejects(() => pool.query('SELECT * FROM ' + table), { code: '42501' })
    await assert.rejects(() => own(f, connection => connection.query('UPDATE ' + table + ' SET owner_id=$1', [f.bob.user.id])), { code: '42501' })
  }
  await assert.rejects(() => own(f, connection => connection.query('UPDATE workspace_file_state SET file_id=$1 WHERE file_id=$2', [other,id])), { code: '23503' })
  await assert.rejects(() => own(f, connection => connection.query('UPDATE workspace_file_state SET folder_id=$1 WHERE file_id=$2', [bFolder.id,id])), { code: '23503' })
  await assert.rejects(() => own(f, connection => connection.query('UPDATE workspace_folders SET parent_id=$1 WHERE id=$2', [bFolder.id,box.id])), { code: '23503' })
  await f.ownerPool.query('GRANT SELECT ON workspace_file_state TO ' + f.names.auth)
  await assert.rejects(() => assertRuntimePool(f.authPool, 'auth'))
  await f.ownerPool.query('REVOKE SELECT ON workspace_file_state FROM ' + f.names.auth)
  await f.ownerPool.query('ALTER TABLE workspace_folders NO FORCE ROW LEVEL SECURITY')
  await assert.rejects(() => assertRuntimePool(f.businessPool, 'business'))
})

test('opposite concurrent folder moves serialize before cycle validation', { timeout: 30_000 }, async t => {
  const f = await fileFixture(t), left = await folder(f, 'Left'), right = await folder(f, 'Right')
  const { createWorkspaceService } = await import('../../server/src/modules/workspace/service.ts')
  let entered, release
  const ready = new Promise(resolve => { entered = resolve }), barrier = new Promise(resolve => { release = resolve })
  const holding = createWorkspaceService({ withPrincipalTransaction: (input, operation) => f.transactions.withPrincipalTransaction(input, async (...args) => {
    const value = await operation(...args); entered(); await barrier; return value
  }) })
  const first = holding.updateFolder(f.alice.token, left.id, { parentId: right.id })
  let second
  try {
    await Promise.race([ready, first.then(() => { throw new Error('Folder transaction ended before lock barrier') })])
    second = createWorkspaceService(f.transactions).updateFolder(f.alice.token, right.id, { parentId: left.id }).then(value => ({ value }), error => ({ error }))
    await waitForDatabaseLock(f, 'business')
    release(); await first
    assert.equal((await second).error?.statusCode, 409)
    const tree = (await request(f, 'GET', '/folders')).json().folders
    assert.equal(tree.find(row => row.id === left.id).parentId, right.id)
    assert.equal(tree.find(row => row.id === right.id).parentId, null)
  } finally { release(); await Promise.allSettled([first, second].filter(Boolean)) }
})

test('moving a file into a folder prevents a concurrent folder deletion after its lock wait', { timeout: 30_000 }, async t => {
  const f = await fileFixture(t), id = await imported(f), box = await folder(f, 'Destination')
  const { createWorkspaceService } = await import('../../server/src/modules/workspace/service.ts')
  let entered, release
  const ready = new Promise(resolve => { entered = resolve }), barrier = new Promise(resolve => { release = resolve })
  const holding = createWorkspaceService({ withPrincipalTransaction: (input, operation) => f.transactions.withPrincipalTransaction(input, async (...args) => {
    const value = await operation(...args); entered(); await barrier; return value
  }) })
  const first = holding.moveFile(f.alice.token, id, { folderId: box.id })
  let second
  try {
    await Promise.race([ready, first.then(() => { throw new Error('File transaction ended before lock barrier') })])
    second = createWorkspaceService(f.transactions).deleteFolder(f.alice.token, box.id).then(value => ({ value }), error => ({ error }))
    await waitForDatabaseLock(f, 'business')
    release(); await first
    assert.equal((await second).error?.statusCode, 409)
    assert.equal((await list(f, '?folderId=' + box.id)).files[0].id, id)
  } finally { release(); await Promise.allSettled([first, second].filter(Boolean)) }
})
