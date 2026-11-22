import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAssistantSourceMode } from '../../server/assistant-source-mode.mjs'

const ready = { DYOFFICE_CONFIG_KEYRING: 'k', DYOFFICE_SOURCES_CREDENTIAL_KEYS: 'c' }
const local = { authMode: 'local' }

test('Office data analysis is on by default when every prerequisite is configured', () => {
  assert.equal(resolveAssistantSourceMode(ready, local), 'read-only-analysis')
  assert.equal(resolveAssistantSourceMode({ DYOFFICE_PROVIDER_GATEWAY_PROFILES: '/p.json', DYOFFICE_SOURCES_CREDENTIAL_KEYS: 'c' }, local), 'read-only-analysis')
  assert.equal(resolveAssistantSourceMode({ ...ready, DYOFFICE_ASSISTANT_SOURCE_CATALOG: '' }, local), 'read-only-analysis')
})

test('the default falls back to off without failing startup when a prerequisite is missing', () => {
  assert.equal(resolveAssistantSourceMode(ready, { authMode: 'development' }), 'off')
  assert.equal(resolveAssistantSourceMode({ DYOFFICE_SOURCES_CREDENTIAL_KEYS: 'c' }, local), 'off')
  assert.equal(resolveAssistantSourceMode({ DYOFFICE_CONFIG_KEYRING: 'k' }, local), 'off')
  assert.equal(resolveAssistantSourceMode({}, { authMode: 'development' }), 'off')
})

test('an explicit value always wins, including off', () => {
  assert.equal(resolveAssistantSourceMode({ ...ready, DYOFFICE_ASSISTANT_SOURCE_CATALOG: 'off' }, local), 'off')
  assert.equal(resolveAssistantSourceMode({ ...ready, DYOFFICE_ASSISTANT_SOURCE_CATALOG: 'metadata-only' }, local), 'metadata-only')
  // metadata-only lists connection names and needs no credential keys.
  assert.equal(resolveAssistantSourceMode({ DYOFFICE_CONFIG_KEYRING: 'k', DYOFFICE_ASSISTANT_SOURCE_CATALOG: 'metadata-only' }, local), 'metadata-only')
})

test('an explicit non-off mode fails fast and names every missing prerequisite', () => {
  assert.throws(() => resolveAssistantSourceMode({ DYOFFICE_ASSISTANT_SOURCE_CATALOG: 'read-only-analysis' }, { authMode: 'development' }),
    /DYOFFICE_AUTH_MODE=local.*DYOFFICE_PROVIDER_GATEWAY_PROFILES or DYOFFICE_CONFIG_KEYRING.*DYOFFICE_SOURCES_CREDENTIAL_KEYS/)
  assert.throws(() => resolveAssistantSourceMode({ DYOFFICE_CONFIG_KEYRING: 'k', DYOFFICE_ASSISTANT_SOURCE_CATALOG: 'read-only-analysis' }, local), /DYOFFICE_SOURCES_CREDENTIAL_KEYS/)
  assert.throws(() => resolveAssistantSourceMode({ ...ready, DYOFFICE_ASSISTANT_SOURCE_CATALOG: 'on' }, local), /must be one of off, metadata-only, read-only-analysis/)
})
