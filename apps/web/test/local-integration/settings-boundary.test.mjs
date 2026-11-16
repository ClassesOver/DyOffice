import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { restrictedFixture, restrictedOrigin, waitForDatabaseLock } from '../helpers/restricted.mjs'
import { password } from '../helpers/identity.mjs'
import { createCsrfService } from '../../server/src/modules/auth/csrf.ts'
import { tokenHash, createSessionService } from '../../server/src/modules/auth/sessions.ts'
import { createAccountService } from '../../server/src/modules/auth/service.ts'
import { createPrincipalTransactions } from '../../server/src/db/context.ts'
import { createApiShell } from '../../server/src/framework.ts'

const keyring = { activeKeyId: 'k1', keys: { k1: new Uint8Array(32).fill(19) } }
const entry = { id: 'primary', kind: 'chat', providerId: 'openai', label: 'Primary', model: 'gpt-6-luna', baseUrl: 'https://provider.example/v1', enabled: true }
const sentinel = 't12-secret-sentinel-not-in-public-output'
async function fixture(t, supplied = keyring, options = {}) {
  const { createGlobalConfigService } = await import('../../server/src/modules/admin/service.ts')
  const { registerGlobalConfigRoutes } = await import('../../server/src/modules/admin/routes.ts')
  const f = await restrictedFixture(t, { businessMax: 4, ...options })
  const settings = createGlobalConfigService({ transactions: f.transactions, keyring: supplied })
  const csrf = createCsrfService({ db: f.db, deploymentId: f.deploymentId, origin: restrictedOrigin, key: f.csrfKey })
  const app = await createApiShell(); registerGlobalConfigRoutes(app, settings, f.sessions, csrf); await app.ready()
  f.cleanup.push(() => app.close())
  return { ...f, settings, configApp: app, csrf,
    headers(token = f.adminSigned.token) { return { cookie: '__Host-dyoffice-session=' + token, origin: restrictedOrigin, 'x-csrf-token': csrf.sessionToken(token) } },
  }
}
async function sqlAs(f, token, operation) {
  return f.transactions.withPrincipalTransaction({ kind: 'session', token }, async (connection, principal) => {
    await connection.query("SELECT set_config('dyoffice.global_session_hash',$1,true),set_config('dyoffice.global_idle_ms',$2,true)", [tokenHash(token), String(f.transactions.sessionIdleMs)])
    return operation(connection, principal)
  })
}
const revisionCount = async f => (await sqlAs(f, f.adminSigned.token, c => c.query('SELECT revision FROM global_configs'))).rows.map(r => r.revision)
async function auditRows(f) {
  const connection = await f.ownerPool.connect()
  try {
    await connection.query('BEGIN')
    await connection.query("SELECT set_config('dyoffice.deployment_id',$1,true),set_config('dyoffice.user_id',$2,true),set_config('dyoffice.session_id',$3,true),set_config('dyoffice.global_session_hash',$4,true),set_config('dyoffice.global_idle_ms',$5,true)", [f.deploymentId,f.initial.id,f.adminSigned.sessionId,tokenHash(f.adminSigned.token),String(f.transactions.sessionIdleMs)])
    return (await connection.query('SELECT action,revision,entry_ids FROM global_config_audit ORDER BY created_at,id')).rows
  } finally { await connection.query('ROLLBACK'); connection.release() }
}

test('local settings routes enforce cookies, admin authority, CSRF and public safe projection', async t => {
  const f = await fixture(t)
  for (const url of ['/api/v1/settings/public','/api/v1/admin/config']) {
    assert.equal((await f.configApp.inject({ method: 'GET', url })).statusCode, 401)
    assert.equal((await f.configApp.inject({ method: 'GET', url, headers: { authorization: 'Bearer admin-secret' } })).statusCode, 401)
  }
  assert.equal((await f.configApp.inject({ method: 'GET', url: '/api/v1/admin/config', headers: f.headers(f.alice.token) })).statusCode, 403)
  assert.equal((await f.configApp.inject({ method: 'PUT', url: '/api/v1/admin/config', headers: { cookie: f.headers().cookie }, payload: { expectedRevision: 0, patch: { upserts: [entry] } } })).statusCode, 403)
  const saved = await f.configApp.inject({ method: 'PUT', url: '/api/v1/admin/config', headers: { ...f.headers(), 'if-match': '"0"' }, payload: { patch: { upserts: [{ ...entry, apiKey: sentinel }], defaults: { chat: entry.id } } } })
  assert.equal(saved.statusCode, 200); assert.equal(saved.headers.etag, '"1"'); assert.equal(saved.json().entries[0].hasKey, true)
  const publicResult = await f.configApp.inject({ method: 'GET', url: '/api/v1/settings/public', headers: f.headers(f.alice.token) })
  assert.deepEqual(publicResult.json(), { revision: 1, catalog: [{ id: 'primary', kind: 'chat', providerId: 'openai', label: 'Primary', model: 'gpt-6-luna' }], defaults: { chat: 'primary' } })
  assert.equal(publicResult.headers['cache-control'], 'private, no-store')
  assert.doesNotMatch(saved.body + publicResult.body, new RegExp(sentinel + '|ciphertext'))
  assert.doesNotMatch(publicResult.body, /provider\.example/)
})

test('omitted and blank keys preserve ciphertext; explicit clear and removal are atomic', async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [{ ...entry, apiKey: sentinel }] })
  const original = (await sqlAs(f, f.adminSigned.token, c => c.query('SELECT envelope FROM global_config_secrets'))).rows[0].envelope
  await f.settings.saveGlobalConfig(f.adminSigned.token, 1, { upserts: [{ ...entry, label: 'Renamed', apiKey: '' }] })
  assert.deepEqual((await sqlAs(f, f.adminSigned.token, c => c.query('SELECT envelope FROM global_config_secrets'))).rows[0].envelope, original)
  await assert.rejects(f.settings.saveGlobalConfig(f.adminSigned.token, 2, { upserts: [{ ...entry, providerId: 'custom' }] }), { statusCode: 400 })
  assert.deepEqual(await revisionCount(f), [2])
  const cleared = await f.settings.saveGlobalConfig(f.adminSigned.token, 2, { upserts: [{ ...entry, clearKey: true }] })
  assert.equal(cleared.entries[0].hasKey, false)
  assert.equal((await sqlAs(f, f.adminSigned.token, c => c.query('SELECT * FROM global_config_secrets'))).rowCount, 0)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 3, { removes: ['primary'] })
  assert.deepEqual((await f.settings.getAdminConfig(f.adminSigned.token)).entries, [])
})

test('same-revision concurrent admin saves have one winner and a conflict without partial keys or audit effects', async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [entry] })
  const results = await Promise.allSettled([
    f.settings.saveGlobalConfig(f.adminSigned.token, 1, { upserts: [{ ...entry, label: 'First', apiKey: sentinel }] }),
    f.settings.saveGlobalConfig(f.adminSigned.token, 1, { upserts: [{ ...entry, label: 'Second', apiKey: 'other-secret' }] }),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409)
  assert.deepEqual(await revisionCount(f), [2])
  assert.equal((await sqlAs(f, f.adminSigned.token, c => c.query('SELECT * FROM global_config_secrets'))).rowCount, 1)
  const audit = await auditRows(f)
  assert.deepEqual(audit, [{ action: 'config_saved', revision: 1, entry_ids: ['primary'] }, { action: 'config_saved', revision: 2, entry_ids: ['primary'] }])
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(sentinel + '|other-secret|provider\\.example'))
})

test('personal preference fields cannot enter global configuration and global fields cannot enter preferences', async t => {
  const f = await fixture(t)
  await assert.rejects(f.settings.saveGlobalConfig(f.adminSigned.token, 0, { theme: 'dark', upserts: [entry] }), { statusCode: 400 })
  await assert.rejects(f.preferences.update(f.alice.token, { models: [entry] }), { statusCode: 400 })
  assert.deepEqual(await revisionCount(f), [])
  const conflict = await f.configApp.inject({ method: 'PUT', url: '/api/v1/admin/config', headers: { ...f.headers(), 'if-match': '"1"' }, payload: { expectedRevision: 0, patch: { upserts: [entry] } } })
  assert.equal(conflict.statusCode, 400)
  const missing = await f.configApp.inject({ method: 'PUT', url: '/api/v1/admin/config', headers: f.headers(), payload: { patch: { upserts: [entry] } } })
  assert.equal(missing.statusCode, 428)
})

test('secret RLS denies personal SQL, forged admin context, missing identity and auth-pool table reads', async t => {
  const f = await fixture(t, keyring, { worker: true })
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [{ ...entry, apiKey: sentinel }] })
  assert.equal((await f.businessPool.query('SELECT * FROM global_config_secrets')).rowCount, 0)
  assert.equal((await sqlAs(f, f.alice.token, c => c.query('SELECT * FROM global_config_secrets'))).rowCount, 0)
  await assert.rejects(f.authPool.query('SELECT * FROM global_config_secrets'), { code: '42501' })
  await assert.rejects(f.workerPool.query('SELECT * FROM global_config_secrets'), { code: '42501' })
  await assert.rejects(sqlAs(f, f.alice.token, c => c.query("INSERT INTO global_configs(deployment_id) VALUES($1)", [randomUUID()])), { code: '42501' })
  const forged = await sqlAs(f, f.alice.token, async c => {
    await c.query("SELECT set_config('dyoffice.user_id',$1,true),set_config('dyoffice.session_id',$2,true)", [f.initial.id, f.adminSigned.sessionId])
    return c.query('SELECT * FROM global_config_secrets')
  })
  assert.equal(forged.rowCount, 0, 'Admin IDs without its verified token hash cannot create authority')
  const flags = (await f.businessPool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=ANY(ARRAY['global_configs'::regclass,'global_config_entries'::regclass,'global_config_secrets'::regclass,'global_config_audit'::regclass])")).rows
  assert.equal(flags.length, 4); assert.ok(flags.every(r => r.relrowsecurity && r.relforcerowsecurity))
  assert.equal((await f.businessPool.query("SELECT current_setting('dyoffice.global_session_hash',true) AS value")).rows[0].value || '', '')
})

test('global configurations and ciphertext cannot cross deployment boundaries', async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [{ ...entry, apiKey: sentinel }] })
  const otherId = randomUUID()
  const ownerAccounts = createAccountService({ db: f.ownerDb, passwords: f.passwords, deploymentId: otherId })
  await ownerAccounts.bootstrapAdmin({ username: 'owner-two', password })
  const accounts = createAccountService({ db: f.db, passwords: f.passwords, deploymentId: otherId })
  const sessions = createSessionService({ db: f.db, accounts, deploymentId: otherId })
  const signed = await sessions.login('owner-two', password)
  const { createGlobalConfigService } = await import('../../server/src/modules/admin/service.ts')
  const other = createGlobalConfigService({ transactions: createPrincipalTransactions({ pool: f.businessPool, deploymentId: otherId }), keyring })
  assert.deepEqual((await other.getAdminConfig(signed.token)).entries, [])
  await assert.rejects(other.getAdminConfig(f.adminSigned.token), { statusCode: 401 })
  await other.saveGlobalConfig(signed.token, 0, { upserts: [{ ...entry, label: 'Other deployment' }] })
  assert.equal((await f.settings.getAdminConfig(f.adminSigned.token)).entries[0].label, 'Primary')
  assert.equal((await other.getAdminConfig(signed.token)).entries[0].hasKey, false)
})

test('keyring is optional for catalog and metadata but secret writes fail closed without revision changes', async t => {
  const f = await fixture(t)
  const { createGlobalConfigService } = await import('../../server/src/modules/admin/service.ts')
  const noKeys = createGlobalConfigService({ transactions: f.transactions })
  assert.equal((await noKeys.getAdminConfig(f.adminSigned.token)).keyStorageAvailable, false)
  await noKeys.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [entry] })
  await assert.rejects(noKeys.saveGlobalConfig(f.adminSigned.token, 1, { upserts: [{ ...entry, apiKey: sentinel }] }), { statusCode: 503 })
  assert.deepEqual(await revisionCount(f), [1])
  assert.equal((await noKeys.getPublicSettings(f.alice.token)).catalog.length, 1)
})

test('rotation failure after the first key is re-encrypted rolls back every ciphertext revision and audit', async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [{ ...entry, apiKey: sentinel }, { ...entry, id: 'second', apiKey: 'second-secret' }] })
  const before = (await sqlAs(f, f.adminSigned.token, c => c.query('SELECT entry_id,key_id,envelope FROM global_config_secrets ORDER BY entry_id'))).rows
  await sqlAs(f, f.adminSigned.token, c => c.query("UPDATE global_config_secrets SET envelope=jsonb_set(envelope,'{ciphertext}',to_jsonb($1::text)) WHERE entry_id='second'", [Buffer.from('damaged ciphertext').toString('base64')]))
  const { createGlobalConfigService } = await import('../../server/src/modules/admin/service.ts')
  const rotating = createGlobalConfigService({ transactions: f.transactions, keyring: { activeKeyId: 'k2', keys: { ...keyring.keys, k2: new Uint8Array(32).fill(31) } } })
  await assert.rejects(rotating.rotateKey(f.adminSigned.token, 1), { statusCode: 503 })
  const after = (await sqlAs(f, f.adminSigned.token, c => c.query('SELECT entry_id,key_id,envelope FROM global_config_secrets ORDER BY entry_id'))).rows
  assert.deepEqual(after[0], before[0])
  assert.equal(after[1].key_id, 'k1')
  assert.deepEqual(await revisionCount(f), [1])
  assert.deepEqual(await auditRows(f), [{ action: 'config_saved', revision: 1, entry_ids: ['primary','second'] }])
})

test('rotation replaces every ciphertext with active key ID in one transaction and preserves decryption', async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [{ ...entry, apiKey: sentinel }, { ...entry, id: 'second', apiKey: 'second-private-key' }] })
  const { createGlobalConfigService } = await import('../../server/src/modules/admin/service.ts')
  const rotated = createGlobalConfigService({ transactions: f.transactions, keyring: { activeKeyId: 'k2', keys: { ...keyring.keys, k2: new Uint8Array(32).fill(31) } } })
  const result = await rotated.rotateKey(f.adminSigned.token, 1)
  assert.equal(result.revision, 2)
  const stored = (await sqlAs(f, f.adminSigned.token, c => c.query('SELECT key_id,envelope FROM global_config_secrets ORDER BY entry_id'))).rows
  assert.deepEqual(stored.map(r => r.key_id), ['k2','k2'])
  assert.equal(JSON.stringify(stored).includes(sentinel), false)
  assert.deepEqual(await rotated.checkGlobalConfig(f.adminSigned.token, { expectedRevision: 2 }), { revision: 2, configuration: 'valid', checkedEntries: 2, secrets: 'readable', connection: 'not_run' })
  await assert.rejects(f.settings.rotateKey(f.adminSigned.token, 2), { statusCode: 503 })
  assert.deepEqual(await revisionCount(f), [2])
  assert.deepEqual((await sqlAs(f, f.adminSigned.token, c => c.query('SELECT key_id FROM global_config_secrets ORDER BY entry_id'))).rows.map(r => r.key_id), ['k2','k2'])
})

test('disabled defaults disappear from public catalog without enabling a replacement provider', async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [entry], defaults: { chat: 'primary' } })
  await f.settings.saveGlobalConfig(f.adminSigned.token, 1, { upserts: [{ ...entry, enabled: false }] })
  assert.deepEqual(await f.settings.getPublicSettings(f.alice.token), { revision: 2, catalog: [], defaults: {} })
  await assert.rejects(f.settings.saveGlobalConfig(f.adminSigned.token, 2, { defaults: { chat: 'primary' } }), { statusCode: 400 })
})

test('If-Match alone can rotate the saved configuration and local checks never perform external requests', async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [{ ...entry, apiKey: sentinel }] })
  const checked = await f.configApp.inject({ method: 'POST', url: '/api/v1/admin/config/check', headers: f.headers(), payload: { expectedRevision: 1, entryId: 'primary' } })
  assert.equal(checked.statusCode, 200)
  assert.deepEqual(checked.json(), { revision: 1, configuration: 'valid', checkedEntries: 1, secrets: 'readable', connection: 'not_run' })
  const rotated = await f.configApp.inject({ method: 'POST', url: '/api/v1/admin/config/rotate-key', headers: { ...f.headers(), 'if-match': '"1"' } })
  assert.equal(rotated.statusCode, 200)
  assert.equal(rotated.json().revision, 2)
  const stale = await f.configApp.inject({ method: 'POST', url: '/api/v1/admin/config/check', headers: f.headers(), payload: { expectedRevision: 1 } })
  assert.equal(stale.statusCode, 409)
})

test('admin reads return one saved snapshot while a concurrent writer changes entries and revision', { timeout: 25_000 }, async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [entry] })
  const { createGlobalConfigService } = await import('../../server/src/modules/admin/service.ts')
  let signal, release, paused = false
  const entered = new Promise(resolve => { signal = resolve }), barrier = new Promise(resolve => { release = resolve })
  const reader = createGlobalConfigService({ keyring, transactions: {
    sessionIdleMs: f.transactions.sessionIdleMs,
    withPrincipalTransaction: (input, operation) => f.transactions.withPrincipalTransaction(input, (connection, principal) => operation({
      async query(...args) {
        const value = await connection.query(...args)
        if (!paused && String(args[0]).startsWith('SELECT revision,defaults')) { paused = true; signal(); await barrier }
        return value
      },
    }, principal)),
  } })
  const reading = reader.getAdminConfig(f.adminSigned.token)
  let writing, finished = false
  try {
    await Promise.race([entered, reading.then(() => { throw new Error('Expected read barrier') })])
    writing = f.settings.saveGlobalConfig(f.adminSigned.token, 1, { upserts: [{ ...entry, label: 'Next version' }] }).finally(() => { finished = true })
    const deadline = Date.now() + 4000
    while (!finished) {
      const blocked = await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'", [f.database,f.businessPool.options.application_name])
      if (blocked.rowCount) break
      if (Date.now() > deadline) throw new Error('Writer neither completed nor reached the read boundary')
      await new Promise(resolve => setImmediate(resolve))
    }
    release()
    const snapshot = await reading
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.entries[0].label, 'Primary')
    await writing
    assert.equal((await f.settings.getAdminConfig(f.adminSigned.token)).revision, 2)
  } finally { release(); await Promise.allSettled([reading,writing].filter(Boolean)) }
})

for (const revoke of ['session','role']) test(`${revoke} revocation prevents an already waiting configuration writer`, { timeout: 25_000 }, async t => {
  const f = await fixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 0, { upserts: [entry] })
  const lock = await f.authPool.connect()
  let writing
  try {
    await lock.query('BEGIN')
    await lock.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.initial.id])
    writing = f.settings.saveGlobalConfig(f.adminSigned.token, 1, { upserts: [{ ...entry, label: 'Must not commit' }] }).then(value => ({ value }), error => ({ error }))
    await waitForDatabaseLock(f, 'business')
    if (revoke === 'session') await lock.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [f.adminSigned.sessionId])
    else await lock.query("DELETE FROM user_roles WHERE user_id=$1 AND role='config_admin'", [f.initial.id])
    await lock.query('COMMIT')
    assert.equal((await writing).error.statusCode, revoke === 'session' ? 401 : 403)
  } finally { await lock.query('ROLLBACK'); lock.release() }
  const actual = await f.settings.getPublicSettings(f.alice.token)
  assert.equal(actual.revision, 1)
  assert.equal(actual.catalog[0].label, 'Primary')
})


test('full configuration replacement audits both removed and inserted identities', async t => {
  const f=await fixture(t)
  const old=Array.from({length:100},(_,i)=>({...entry,id:'old-'+i}))
  const next=Array.from({length:100},(_,i)=>({...entry,id:'new-'+i}))
  await f.settings.saveGlobalConfig(f.adminSigned.token,0,{upserts:old})
  const saved=await f.settings.saveGlobalConfig(f.adminSigned.token,1,{removes:old.map(e=>e.id),upserts:next})
  assert.equal(saved.revision,2);assert.equal(saved.entries.length,100)
  const audit=await auditRows(f)
  assert.equal(audit.at(-1).entry_ids.length,200)
})
