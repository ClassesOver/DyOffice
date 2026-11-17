import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {restrictedFixture} from '../helpers/restricted.mjs'
import {createGlobalConfigService} from '../../server/src/modules/admin/service.ts'
import {createProviderBudgetService, isDefinitiveBudgetDenial} from '../../server/src/modules/providers/budget.ts'
import {buildLocalApp} from '../../server/src/app.ts'
import {createCsrfService} from '../../server/src/modules/auth/csrf.ts'

const entry = {id: 'personal-chat', kind: 'chat', providerId: 'openai', label: 'Chat', model: 'test', baseUrl: 'https://provider.example/v1', enabled: true}
async function personalFixture(t) {
  const f = await restrictedFixture(t, {businessMax: 4})
  const keyring = {activeKeyId: 'test', keys: {test: new Uint8Array(32).fill(25)}}
  const settings = createGlobalConfigService({transactions: f.transactions, keyring})
  await settings.saveGlobalConfig(f.adminSigned.token, 0, {upserts: [{...entry, apiKey: 'synthetic-private-key'}], defaults: {chat: entry.id}})
  // Only the migration/provisioning owner can fund these accounts.
  await f.ownerPool.query('INSERT INTO provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision,available_units,per_call_units) VALUES($1,$2,$3,1,10,10)', [f.deploymentId, f.alice.user.id, entry.id])
  const budget = createProviderBudgetService({transactions: f.transactions, audience: 'personal'})
  const binding = {turnId: randomUUID(), entryId: entry.id, configRevision: 1, requestDigest: 'a'.repeat(64)}
  return {...f, settings, budget, binding, keyring, entry}
}

test('ordinary user spends only own provisioned model budget; other users, replay, and zero balance are denied', async t => {
  const f = await personalFixture(t)
  await assert.rejects(f.budget.reserve(f.bob.token, f.binding))
  await assert.rejects(createProviderBudgetService({transactions: f.transactions}).reserve(f.alice.token, f.binding))
  const reserved = await f.budget.reserve(f.alice.token, f.binding)
  assert.equal(reserved.userId, f.alice.user.id)
  assert.equal(reserved.state, 'reserved')
  await assert.rejects(f.budget.reserve(f.alice.token, {...f.binding, turnId: randomUUID()}))
  const claimed = await f.budget.claim(f.alice.token, f.binding)
  await f.budget.takeForDispatch(f.alice.token, f.binding, claimed.claimId)
  await assert.rejects(f.budget.takeForDispatch(f.alice.token, f.binding, claimed.claimId))
  await f.budget.settle(f.alice.token, f.binding, claimed.claimId)
  assert.equal((await f.budget.status(f.alice.token, f.binding)).state, 'settled')
  await assert.rejects(f.budget.status(f.bob.token, f.binding))
})

test('personal budget admission rejects disabled model and revoked session', async t => {
  const f = await personalFixture(t)
  await f.settings.saveGlobalConfig(f.adminSigned.token, 1, {upserts: [{...entry, enabled: false}]})
  await assert.rejects(f.budget.reserve(f.alice.token, f.binding))
  await f.sessions.logout(f.alice.token)
  await assert.rejects(f.budget.reserve(f.alice.token, f.binding), isDefinitiveBudgetDenial)
})

test('personal HTTP gateway is opt-in and an unfunded account cannot dispatch or poison shutdown', async t => {
  const f = await personalFixture(t), origin = 'https://office.example'
  const csrf = createCsrfService({db: f.db, deploymentId: f.deploymentId, origin, key: f.csrfKey})
  const headers = {cookie: '__Host-dyoffice-session=' + f.bob.token, origin, 'x-csrf-token': csrf.sessionToken(f.bob.token)}
  assert.deepEqual((await f.app.inject({url: '/api/v1/ai/catalog', headers})).json(), {entries: [], defaultId: null})
  const profile = {deploymentId: f.deploymentId, entryId: entry.id, revision: 1, providerId: entry.providerId, model: entry.model, baseUrl: entry.baseUrl, endpoint: entry.baseUrl + '/chat/completions', allowedIpv4: ['8.8.8.8'], maxOutputTokens: 128}
  const app = await buildLocalApp({db: f.db, businessPool: f.businessPool, passwords: f.passwords, deploymentId: f.deploymentId, origin, csrfKey: f.csrfKey, globalConfigKeyring: f.keyring, providerGateway: {profiles: [profile]}})
  f.cleanup.push(() => app.close())
  const aliceHeaders = {...headers, cookie: '__Host-dyoffice-session=' + f.alice.token, 'x-csrf-token': csrf.sessionToken(f.alice.token)}
  assert.deepEqual((await app.inject({url: '/api/v1/ai/catalog', headers: aliceHeaders})).json(), {entries: [{id: entry.id, label: entry.label, model: entry.model}], defaultId: entry.id, agents: [{id: 'codex', name: 'Codex', origin: 'builtin', capabilities: ['coding']}], defaultAgentId: 'codex'})
  assert.deepEqual((await app.inject({url: '/api/v1/ai/catalog', headers})).json(), {entries: [], defaultId: null})
  const request = {method: 'POST', url: '/api/v1/ai/turns', headers, payload: {turnId: randomUUID(), modelId: entry.id, request: {system: '', messages: [{role: 'user', text: 'synthetic'}], tools: []}}}
  assert.equal((await f.app.inject(request)).statusCode, 501)
  const invalid = await app.inject({...request, payload: {...request.payload, apiKey: 'injected'}})
  assert.equal(invalid.statusCode, 400)
  const rejected = await app.inject(request)
  assert.equal(rejected.statusCode, 200)
  assert.match(rejected.body, /event: error[\s\S]*event: done/)
  assert.equal((await f.ownerPool.query('SELECT * FROM provider_budget_reservations')).rowCount, 0)
  await app.close()
})
