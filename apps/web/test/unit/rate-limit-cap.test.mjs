import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFixedWindowLimiter } from '../../server/src/rate-limit.mjs'

test('active source capacity rejects new addresses without resetting existing quotas', () => {
  const hit = createFixedWindowLimiter({ max: 2, windowMs: 60_000 })
  for (let i = 0; i < 5000; i++) assert.equal(hit(`address-${i}`, 1000), null)
  assert.deepEqual(hit('overflow', 1000), { retryAfter: 60 })
  assert.equal(hit('address-0', 1000), null)
  assert.deepEqual(hit('address-0', 1000), { retryAfter: 60 })
  for (let i = 0; i < 50; i++) assert.deepEqual(hit(`extra-${i}`, 2000), { retryAfter: 59 })
  assert.deepEqual(hit('address-0', 2000), { retryAfter: 59 })
  assert.equal(hit('overflow', 61_000), null)
})

test('reclaims expired capacity without dropping unexpired source buckets', () => {
  const hit = createFixedWindowLimiter({ max: 1, windowMs: 1000 })
  assert.equal(hit('early', 0), null)
  for (let i = 0; i < 4999; i++) assert.equal(hit(`late-${i}`, 500), null)
  assert.deepEqual(hit('new', 999), { retryAfter: 1 })
  assert.equal(hit('new', 1000), null)
  assert.deepEqual(hit('late-0', 1000), { retryAfter: 1 })
  assert.deepEqual(hit('another', 1000), { retryAfter: 1 })
})

test('backwards clock does not reorder expiry or prematurely release quotas', () => {
  const hit = createFixedWindowLimiter({ max: 1, windowMs: 1000 })
  assert.equal(hit('first', 1000), null)
  assert.equal(hit('second', 0), null)
  assert.deepEqual(hit('second', 1000), { retryAfter: 1 })
  assert.equal(hit('second', 2000), null)
})
