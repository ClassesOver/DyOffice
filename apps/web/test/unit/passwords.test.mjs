import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPasswordService, normalizeUsername } from '../../server/src/modules/auth/passwords.ts'

const phrase = 'violet river lanterns drift 8246'

test('local usernames have one ASCII identity and reject ambiguous or oversized names', () => {
  assert.equal(normalizeUsername('  Alice.Example  '), 'alice.example')
  for (const value of ['', 'ab', 'a'.repeat(65), 'аlice', 'a b', ['alice']]) {
    assert.throws(() => normalizeUsername(value), { code: 'INVALID_USERNAME' })
  }
})

test('passwords reject empty, short and blocked values while preserving long Unicode passphrases', async () => {
  const passwords = await createPasswordService({ blockedPasswords: ['known compromised long phrase'] })
  for (const value of ['', 'short', 'passwordpassword', '123456789012345', ' '.repeat(16), 'known compromised long phrase', 'x'.repeat(1025)]) {
    await assert.rejects(() => passwords.hash(value), { code: 'INVALID_PASSWORD' })
  }
  const unicode = '  星河里的灯笼慢慢飘向遥远的山川与大海  '
  const encoded = await passwords.hash(unicode)
  assert.equal(await passwords.verifyCandidate(unicode, encoded), true)
  assert.equal(await passwords.verifyCandidate(unicode.trim(), encoded), false)
})

test('Argon2id hashes use independent salts, required parameters and generic invalid verification', async () => {
  const passwords = await createPasswordService()
  const a = await passwords.hash(phrase)
  const b = await passwords.hash(phrase)
  assert.notEqual(a, b)
  assert.match(a, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  assert.equal(await passwords.verifyCandidate(phrase, a), true)
  assert.equal(await passwords.verifyCandidate('incorrect password phrase', a), false)
  assert.equal(await passwords.verifyCandidate(phrase), false)
  assert.equal(await passwords.verifyCandidate(phrase, '$argon2id$v=19$m=999999999,t=2,p=1$broken$broken'), false)
  assert.equal(a.includes(phrase), false)
})

test('password hashing bounds active work and rejects overflow instead of growing an unbounded queue', async () => {
  const passwords = await createPasswordService({ maxConcurrent: 1, maxQueued: 1 })
  const first = passwords.hash(phrase)
  const second = passwords.hash(phrase)
  await assert.rejects(() => passwords.hash(phrase), { code: 'AUTH_BUSY' })
  assert.equal((await Promise.all([first, second])).length, 2)
  assert.equal(await passwords.verifyCandidate(phrase, await passwords.hash(phrase)), true)
})
