import test from 'node:test'
import assert from 'node:assert/strict'

const aad = { deploymentId: 'd-one', configId: 'primary', providerId: 'openai', kind: 'chat' }
const ring = { activeKeyId: 'current', keys: { current: new Uint8Array(32).fill(17), previous: new Uint8Array(32).fill(29) } }

test('global secrets use randomized authenticated encryption bound to deployment, configuration and provider', async () => {
  const { createSecretBox } = await import('../server/src/modules/admin/secrets.ts')
  const box = createSecretBox(ring), secret = 't12-private-provider-key'
  const first = box.seal(secret, aad), second = box.seal(secret, aad)
  assert.equal(first.keyId, 'current')
  assert.notEqual(first.ciphertext, second.ciphertext)
  assert.equal(box.unseal(first, aad), secret)
  assert.equal(JSON.stringify(first).includes(secret), false)
  for (const field of ['deploymentId','configId','providerId','kind']) assert.throws(() => box.unseal(first, { ...aad, [field]: 'other' }), { statusCode: 503 })
  const damaged = { ...first, ciphertext: Buffer.from('changed').toString('base64') }
  assert.throws(() => box.unseal(damaged, aad), { statusCode: 503 })
})

test('secret key rotation reads the retained old key and seals only with the active key', async () => {
  const { createSecretBox } = await import('../server/src/modules/admin/secrets.ts')
  const old = createSecretBox({ ...ring, activeKeyId: 'previous' })
  const stored = old.seal('rotate-me', aad), next = createSecretBox(ring)
  const rotated = next.seal(next.unseal(stored, aad), aad)
  assert.equal(rotated.keyId, 'current')
  assert.equal(next.unseal(rotated, aad), 'rotate-me')
  assert.throws(() => createSecretBox({ activeKeyId: 'current', keys: { current: ring.keys.current } }).unseal(stored, aad), { statusCode: 503 })
  assert.throws(() => createSecretBox({ activeKeyId: 'missing', keys: ring.keys }))
  assert.throws(() => createSecretBox({ activeKeyId: 'short', keys: { short: new Uint8Array(31) } }))
})

const entry = { id: 'primary', kind: 'chat', providerId: 'openai', label: 'Primary', model: 'gpt-6-luna', baseUrl: 'https://api.example/v1', enabled: true }

test('global patches reject personal fields, unsupported provider capabilities and ambiguous key clearing', async () => {
  const { validateGlobalConfigPatch } = await import('../server/src/modules/admin/service.ts')
  assert.deepEqual(validateGlobalConfigPatch({ upserts: [{ ...entry, apiKey: '' }] }).upserts, [entry])
  assert.deepEqual(validateGlobalConfigPatch({ upserts: [{ ...entry, clearKey: true }] }).upserts, [{ ...entry, clearKey: true }])
  for (const patch of [
    { theme: 'dark' }, { ownerId: 'other', upserts: [entry] },
    { upserts: [{ ...entry, hasKey: true }] },
    { upserts: [{ ...entry, kind: 'personal' }] },
    { upserts: [{ ...entry, providerId: 'not-a-provider' }] },
    { upserts: [{ ...entry, providerId: 'codex' }] },
    { upserts: [{ ...entry, kind: 'image_search', providerId: 'tavily' }] },
    { upserts: [{ ...entry, apiKey: 'replacement', clearKey: true }] },
    { upserts: [entry, entry] }, { upserts: [entry], removes: ['primary'] },
    { defaults: { theme: 'dark' } }, { defaults: { chat: '' } },
  ]) assert.throws(() => validateGlobalConfigPatch(patch), { statusCode: 400 })
})

test('configured endpoint validation never accepts embedded credentials, queries or fragments', async () => {
  const { validateGlobalConfigPatch } = await import('../server/src/modules/admin/service.ts')
  for (const baseUrl of ['https://user:secret@api.example/v1','https://api.example/v1?api_key=secret','https://api.example/v1#secret','file:///etc/passwd',' https://api.example/v1','https://api.example/v1?']) {
    assert.throws(() => validateGlobalConfigPatch({ upserts: [{ ...entry, baseUrl }] }), error => error.statusCode === 400 && !error.message.includes('secret'))
  }
})

test('public global settings report search readiness without exposing secret material', async () => {
  const { createGlobalConfigService } = await import('../server/src/modules/admin/service.ts')
  const rows = [
    { id: 'web', kind: 'web_search', provider_id: 'serper', label: 'Web', model: '', base_url: '', enabled: true, has_key: false },
    { id: 'keyless', kind: 'web_search', provider_id: 'parallel', label: 'Keyless', model: '', base_url: '', enabled: true, has_key: false },
    { id: 'chat', kind: 'chat', provider_id: 'openai', label: 'Chat', model: 'gpt-6-luna', base_url: '', enabled: true, has_key: true },
  ]
  const connection = { query: async sql => {
    assert.equal(sql.includes('FROM global_config_secrets'), false)
    if (sql.includes('FROM global_configs')) return { rows: [{ revision: 2, defaults: { web_search: 'web' } }] }
    if (sql.includes('global_config_key_readiness()')) return { rows: rows.map(({id,has_key}) => ({id,has_key})) }
    return { rows: rows.map(row => ({...row,has_key:false})) }
  } }
  const transactions = { sessionIdleMs: 1000, withPrincipalTransaction: (_scope, work) => work(connection, { roles: ['personal'], deploymentId: 'd1' }) }
  const service = createGlobalConfigService({ transactions })
  const result = await service.getPublicSettings('a'.repeat(43))
  assert.deepEqual(result.catalog.map(entry => [entry.id, entry.ready]), [['web', false], ['keyless', true], ['chat', true]])
  assert.equal(JSON.stringify(result).includes('has_key'), false)
  assert.equal(JSON.stringify(result).includes('ciphertext'), false)
})

test('global catalog preserves original model, media and search metadata without desktop authorization fallback', async () => {
  const { getProviderCatalog } = await import('../server/src/modules/admin/catalog.ts')
  const { AI_PROVIDERS } = await import('../../../packages/ai-provider/src/providers.ts')
  const { AI_MEDIA_PROVIDERS } = await import('../../../packages/ai-provider/src/media.ts')
  const { AI_SEARCH_PROVIDERS } = await import('../../../packages/ai-provider/src/search-settings.ts')
  const catalog = getProviderCatalog()
  for (const meta of AI_PROVIDERS) assert.ok(catalog.some(item => item.id === meta.id && item.kinds.includes('chat') && meta.models.every(model => item.models.includes(model))))
  for (const meta of AI_MEDIA_PROVIDERS) {
    if (meta.imageProtocol || meta.id === 'genspark' || meta.id === 'custom') assert.ok(catalog.some(item => item.id === meta.id && item.kinds.includes('image_generation')))
    if (meta.analysisProtocol || meta.id === 'genspark' || meta.id === 'custom') assert.ok(catalog.some(item => item.id === meta.id && item.kinds.includes('image_analysis')))
  }
  for (const meta of AI_SEARCH_PROVIDERS) assert.ok(catalog.some(item => item.id === meta.id && item.kinds.includes('web_search')))
  assert.equal(catalog.find(item => item.id === 'codex' && item.kinds.includes('chat')).available, false)
  assert.ok(catalog.filter(item => item.id === 'genspark').every(item => !item.available))
  assert.ok(catalog.some(item => item.kinds.includes('rerank')))
  assert.ok(catalog.some(item => item.kinds.includes('http_mcp')))
})

test('media catalog keeps generation and analysis models separate and puts the original kind default first', async () => {
  const { getProviderCatalog, findProvider } = await import('../server/src/modules/admin/catalog.ts')
  const { AI_MEDIA_PROVIDERS } = await import('../../../packages/ai-provider/src/media.ts')
  const catalog = getProviderCatalog()
  const openai = AI_MEDIA_PROVIDERS.find(meta => meta.id === 'openai')
  const gemini = AI_MEDIA_PROVIDERS.find(meta => meta.id === 'gemini')
  assert.equal(findProvider('image_analysis','openai').models[0], openai.defaultAnalysisModel)
  assert.equal(findProvider('video_analysis','gemini').models[0], gemini.defaultAnalysisModel)
  assert.equal(findProvider('image_generation','openai').models[0], openai.defaultImageModel)
  for (const meta of AI_MEDIA_PROVIDERS) {
    for (const [kind, supported, models, defaultModel] of [
      ['image_generation', Boolean(meta.imageProtocol), meta.imageModels, meta.defaultImageModel],
      ['image_analysis', Boolean(meta.analysisProtocol), meta.analysisModels, meta.defaultAnalysisModel],
      ['video_analysis', Boolean(meta.analysisProtocol && meta.videoAnalysis), meta.analysisModels, meta.defaultAnalysisModel],
    ]) {
      const entries = catalog.filter(item => item.id === meta.id && item.kinds.includes(kind))
      assert.equal(entries.length, supported ? 1 : 0, meta.id + '/' + kind)
      if (!supported) continue
      assert.deepEqual(entries[0].kinds, [kind])
      assert.equal(entries[0].models[0], defaultModel || models[0])
      assert.equal(new Set(entries[0].models).size, entries[0].models.length)
      assert.deepEqual(new Set(entries[0].models), new Set([...models, ...(defaultModel ? [defaultModel] : [])]))
      assert.equal(entries[0].defaultBaseUrl, meta.defaultBaseUrl)
      assert.equal(entries[0].available, meta.id !== 'genspark')
    }
  }
})

