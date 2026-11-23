import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createCodingRecovery } from '../../../../packages/browser-host/src/coding-recovery.ts'

const ID = '11111111-2222-4333-8444-555555555555'
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

test('discovery retries back off and never stack extra status-polling loops', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let lists = 0, statuses = 0
    const fetchImpl = async path => {
      if (path.includes('/status')) { statuses++; return new Response(JSON.stringify({ turnId: ID, documentId: 'doc', agentId: 'codex', state: 'running' }), { status: 200 }) }
      if (path.includes('/events')) return new Response('missing', { status: 404 })
      lists++
      return new Response('busy', { status: 503 })
    }
    const storage = { getItem: () => JSON.stringify([ID]), setItem: () => {} }
    const recovery = createCodingRecovery({ documentId: 'doc', storage, fetchImpl, csrfToken: 'c', onStatus: () => {} })
    await flush()
    for (let second = 0; second < 60; second++) { mock.timers.tick(1000); await flush() }
    // One status poll per second (plus the initial one), not one more loop per discovery retry.
    assert.ok(statuses <= 62, `status polls ${statuses}`)
    // Exponential backoff: 1+2+4+8+16+32 s covers the minute with about 7 list calls, not 60.
    assert.ok(lists <= 8, `discovery calls ${lists}`)
    recovery.dispose()
  } finally { mock.timers.reset() }
})

test('a 429 Retry-After delays the next discovery attempt', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let lists = 0
    const fetchImpl = async () => { lists++; return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }) }
    const recovery = createCodingRecovery({ documentId: 'doc', fetchImpl, csrfToken: 'c', onStatus: () => {} })
    await flush()
    for (let second = 0; second < 29; second++) { mock.timers.tick(1000); await flush() }
    assert.equal(lists, 1)
    mock.timers.tick(1000); await flush()
    assert.equal(lists, 2)
    recovery.dispose()
  } finally { mock.timers.reset() }
})
