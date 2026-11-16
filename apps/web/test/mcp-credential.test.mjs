import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMcpCredentialReader } from '../server/src/modules/mcp-server/credential.ts'
const token = 'a'.repeat(43)
const read = createMcpCredentialReader({ environment: 'production' })
test('standard endpoint accepts one Bearer credential only', () => {
  assert.deepEqual(read({ path: '/mcp', rawHeaders: ['Authorization', `Bearer ${token}`], query: '' }), { kind: 'external-token', token })
  for (const rawHeaders of [[], ['Cookie', `session=${token}`], ['Authorization', `Basic ${token}`], ['Authorization', `Bearer ${token}`, 'authorization', `Bearer ${token}`]]) {
    assert.throws(() => read({ path: '/mcp', rawHeaders, query: '' }), /Unauthorized/)
  }
})
test('test URL credential requires explicit development mode and exact route', () => {
  assert.throws(() => createMcpCredentialReader({ environment: 'production', allowUrlToken: true }), /URL token/)
  assert.throws(() => createMcpCredentialReader({ environment: '', allowUrlToken: true }), /URL token/)
  const dev = createMcpCredentialReader({ environment: 'development', allowUrlToken: true })
  assert.deepEqual(dev({ path: '/dev/mcp', rawHeaders: [], query: `token=${token}` }), { kind: 'external-token', token })
  for (const path of ['/mcp', '/dev/mcp/', '/other']) assert.throws(() => dev({ path, rawHeaders: [], query: `token=${token}` }), /Unauthorized/)
})
test('ambiguity and malformed headers fail closed without exposing secrets', () => {
  const dev = createMcpCredentialReader({ environment: 'test', allowUrlToken: true })
  for (const query of [`token=${token}&token=${token}`, `token=${token}&access_token=${token}`]) assert.throws(() => dev({ path: '/dev/mcp', rawHeaders: [], query }), /Unauthorized/)
  assert.throws(() => dev({ path: '/dev/mcp', rawHeaders: ['Authorization', `Bearer ${token}`], query: `token=${token}` }), /Unauthorized/)
  for (const value of [`Bearer ${token}, Bearer ${token}`, `Bearer ${token}\r\n`, `Bearer ${token}\n`, `Bearer ${'a'.repeat(5000)}`]) {
    assert.throws(() => read({ path: '/mcp', rawHeaders: ['Authorization', value], query: '' }), (error) => error.message === 'Unauthorized')
  }
  assert.throws(() => read({ path: '/mcp', rawHeaders: ['Authorization', `Bearer ${token}`], query: 'access_token=anything' }), /Unauthorized/)
})
test('startup configuration cannot be mutated to enable URL credentials', () => {
  const config = { environment: 'development', allowUrlToken: false }
  const reader = createMcpCredentialReader(config)
  config.allowUrlToken = true
  assert.throws(() => reader({ path: '/dev/mcp', rawHeaders: [], query: `token=${token}` }), /Unauthorized/)
  const result = read({ path: '/mcp', rawHeaders: ['authorization', `bEaReR ${token}`], query: '' })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(result.kind, 'external-token')
})
test('bounded malformed input and encoded duplicate query names are rejected', () => {
  const dev = createMcpCredentialReader({ environment: 'test', allowUrlToken: true })
  for (const query of [`token=${token}&%74oken=${token}`, `token=${token}%0A`, 'x='.padEnd(4097, 'a')]) {
    assert.throws(() => dev({ path: '/dev/mcp', rawHeaders: [], query }), /Unauthorized/)
  }
  assert.throws(() => read({ path: '/mcp', rawHeaders: ['Authorization'], query: '' }), /Unauthorized/)
})
