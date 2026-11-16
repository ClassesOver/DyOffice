import {describe, expect, test} from 'vitest'
import {createGlobalSettingsClient, type GlobalSettingsRequest} from '../../src/shell/global-settings-client'
import type {AdminGlobalConfig, GlobalConfigPatch} from '../../../../packages/web-contracts/src/settings'

const snapshot = (revision = 3): AdminGlobalConfig => ({
  revision, entries: [{id: 'chat-primary', kind: 'chat', providerId: 'openai', label: 'Main', model: 'model-a', baseUrl: 'https://example.test/v1', enabled: true, hasKey: true}],
  defaults: {chat: 'chat-primary'}, keyStorageAvailable: true,
  providerCatalog: [{id: 'openai', label: 'OpenAI', kinds: ['chat'], models: ['model-a'], defaultBaseUrl: 'https://example.test/v1', available: true}],
})
const patch: GlobalConfigPatch = {upserts: [{id: 'chat-primary', kind: 'chat', providerId: 'openai', label: 'Changed', model: 'model-a', baseUrl: 'https://example.test/v1', enabled: true}]}
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}}
const requestFrom = (run: (path: string, method?: string, body?: unknown) => Promise<unknown>): GlobalSettingsRequest => run as GlobalSettingsRequest

test('admin snapshots expose only public metadata and never return extra key fields', async () => {
  const value = snapshot() as AdminGlobalConfig & {keyId: string}
  Object.assign(value.entries[0], {apiKey: 'must-not-return', ciphertext: 'encrypted-secret'})
  value.keyId = 'server-key'
  const client = createGlobalSettingsClient(requestFrom(async () => value))
  const result = await client.load()
  expect(result).toEqual(snapshot())
  expect(JSON.stringify(result)).not.toContain('must-not-return')
  expect(client.getState()).toEqual({pending: null, unknownWrite: false})
})

test('save sends revision and a key-aware whitelist without response-only fields', async () => {
  const sent: unknown[] = []
  const client = createGlobalSettingsClient(requestFrom(async (path, method, body) => {sent.push({path, method, body}); return snapshot(4)}))
  await client.save(3, {upserts: [{...patch.upserts![0], apiKey: '   ', hasKey: true} as never], defaults: {chat: null}})
  expect(sent).toEqual([{path: '/api/v1/admin/config', method: 'PUT', body: {expectedRevision: 3, patch: {...patch, defaults: {chat: null}}}}])
  await expect(client.save(4, {upserts: [{...patch.upserts![0], apiKey: 'replace-secret', clearKey: true}]})).rejects.toMatchObject({code: 'invalid_request'})
  expect(sent).toHaveLength(1)
})

test('one client synchronously fences duplicate mutations and reads across all operations', async () => {
  const pending = deferred<AdminGlobalConfig>()
  const calls: string[] = []
  const client = createGlobalSettingsClient(requestFrom(async (_path, method = 'GET') => {calls.push(method); return pending.promise}))
  const first = client.save(3, patch)
  expect(client.getState().pending).toBe('save')
  await expect(client.save(3, patch)).rejects.toMatchObject({code: 'busy'})
  await expect(client.check(3)).rejects.toMatchObject({code: 'busy'})
  await expect(client.rotate(3)).rejects.toMatchObject({code: 'busy'})
  await expect(client.load({reconcile: true})).rejects.toMatchObject({code: 'busy'})
  expect(calls).toEqual(['PUT'])
  pending.resolve(snapshot(4)); await first
  expect(client.getState().pending).toBeNull()
})

test('in-flight reads cannot overlap a write or a configuration check', async () => {
  const pending = deferred<AdminGlobalConfig>()
  let calls = 0
  const client = createGlobalSettingsClient(requestFrom(async () => {calls++; return pending.promise}))
  const read = client.load()
  await expect(client.save(3, patch)).rejects.toMatchObject({code: 'busy'})
  await expect(client.check(3)).rejects.toMatchObject({code: 'busy'})
  pending.resolve(snapshot()); await read
  expect(calls).toBe(1)
})

test('unknown writes survive remount-style reads until an explicit successful reconciliation', async () => {
  let writes = 0
  const client = createGlobalSettingsClient(requestFrom(async (_path, method = 'GET') => {
    if (method === 'PUT') {writes++; if (writes === 1) throw new Error('Network body contains secret-value'); return snapshot(5)}
    return snapshot(4)
  }))
  await expect(client.save(3, patch)).rejects.toMatchObject({code: 'write_unknown'})
  expect(client.getState().unknownWrite).toBe(true)
  await expect(client.save(3, patch)).rejects.toMatchObject({code: 'write_unknown'})
  await client.load()
  await expect(client.check(4)).rejects.toMatchObject({code: 'write_unknown'})
  await expect(client.rotate(4)).rejects.toMatchObject({code: 'write_unknown'})
  expect(writes).toBe(1)
  await client.load({reconcile: true})
  expect(writes).toBe(1)
  expect(client.getState().unknownWrite).toBe(false)
  await client.save(4, patch)
  expect(writes).toBe(2)
})

describe.each([400, 409, 503])('known HTTP %i rejection', status => {
  test('keeps corrections retryable without exposing server messages', async () => {
    let calls = 0
    const client = createGlobalSettingsClient(requestFrom(async () => {if (++calls === 1) throw Object.assign(new Error('secret-leak'), {status}); return snapshot(4)}))
    const error = await client.save(3, patch).catch(reason => reason)
    expect(error.status).toBe(status)
    expect(error.message).not.toContain('secret-leak')
    expect(client.getState().unknownWrite).toBe(false)
    await client.save(3, patch)
    expect(calls).toBe(2)
  })
})

test('malformed successful mutations remain unknown and stale sessions use a fixed safe error', async () => {
  const client = createGlobalSettingsClient(requestFrom(async () => ({...snapshot(3), apiKey: 'not-a-confirmation'})))
  await expect(client.rotate(3)).rejects.toMatchObject({code: 'write_unknown'})
  expect(client.getState().unknownWrite).toBe(true)
  const stale = createGlobalSettingsClient(requestFrom(async () => {throw Object.assign(new Error('secret-leak'), {code: 'stale_session'})}))
  await expect(stale.load()).rejects.toMatchObject({code: 'stale_session'})
})

test('saved configuration checks explicitly reject a claimed remote connection result', async () => {
  const calls: unknown[] = []
  let connection = 'not_run'
  const client = createGlobalSettingsClient(requestFrom(async (path, method, body) => {calls.push({path, method, body}); return {revision: 3, configuration: 'valid', checkedEntries: 1, secrets: 'readable', connection}}))
  expect(await client.check(3, 'chat-primary')).toEqual({revision: 3, configuration: 'valid', checkedEntries: 1, secrets: 'readable', connection: 'not_run'})
  expect(calls).toEqual([{path: '/api/v1/admin/config/check', method: 'POST', body: {expectedRevision: 3, entryId: 'chat-primary'}}])
  connection = 'connected'
  await expect(client.check(3)).rejects.toMatchObject({code: 'invalid_response'})
  expect(client.getState().unknownWrite).toBe(false)
})

test('rotation only sends the saved revision and not a browser-provided encryption key', async () => {
  const calls: unknown[] = []
  const client = createGlobalSettingsClient(requestFrom(async (path, method, body) => {calls.push({path, method, body}); return snapshot(4)}))
  await client.rotate(3)
  expect(calls).toEqual([{path: '/api/v1/admin/config/rotate-key', method: 'POST', body: {expectedRevision: 3}}])
})

test('the final writable database revision remains valid and its resulting snapshot can be read', async () => {
  const client = createGlobalSettingsClient(requestFrom(async () => snapshot(2147483647)))
  expect((await client.save(2147483646, patch)).revision).toBe(2147483647)
  expect((await client.load()).revision).toBe(2147483647)
  await expect(client.save(2147483647, patch)).rejects.toMatchObject({code: 'invalid_request'})
})

test('subscriptions reveal an exclusive operation and unsubscribe before later completion', async () => {
  const pending = deferred<AdminGlobalConfig>()
  const client = createGlobalSettingsClient(requestFrom(async () => pending.promise))
  const states: unknown[] = []
  const unsubscribe = client.subscribe(() => states.push(client.getState()))
  const load = client.load()
  unsubscribe(); pending.resolve(snapshot()); await load
  expect(states).toEqual([{pending: 'load', unknownWrite: false}])
})
