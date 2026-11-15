import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsername, validateNewPassword, inspectArgon2idHash } from '../server/auth/credential-policy.mjs'

test('usernames normalize ASCII case and trim but reject ambiguity', () => {
  assert.equal(normalizeUsername('  Alice.User_23  '), 'alice.user_23')
  assert.equal(normalizeUsername('A-b'), 'a-b')
  for (const value of ['', 'ab', 'a'.repeat(65), '1abc', ' 中文 ', 'ålice', 'a+b', 'a/b', 'a b', null, {}, '\u0130user']) {
    assert.throws(() => normalizeUsername(value), TypeError, String(value))
  }
})

test('password policy allows long passphrases and Unicode without normalization', () => {
  assert.equal(validateNewPassword('a many words long passphrase'), true)
  assert.equal(validateNewPassword('🧠'.repeat(15) + ' some text'), true)
  assert.equal(validateNewPassword('  leading and trailing spaces  '), true)
  for (const value of ['', 'short', 'password123456789', '123456789012345', 'qwertyuiopasdfgh', 'a'.repeat(257), '🧠'.repeat(257), 'a'.repeat(15) + '\u0000', 42, undefined]) {
    assert.throws(() => validateNewPassword(value), TypeError)
  }
  assert.equal(validateNewPassword('🧠'.repeat(256)), true) // 256 codepoints, 1024 UTF-8 bytes
})

test('password hash inspector accepts only adequate Argon2id PHC metadata', () => {
  const salt = 'a'.repeat(24)
  const digest = 'b'.repeat(43)
  assert.deepEqual(inspectArgon2idHash('$argon2id$v=19$m=19456,t=2,p=1$' + salt + '$' + digest), { memoryKiB:19456,passes:2,parallelism:1 })
  for (const header of ['$argon2i$v=19$m=19456,t=2,p=1', '$argon2id$v=16$m=19456,t=2,p=1', '$argon2id$v=19$m=1000,t=2,p=1', '$argon2id$v=19$m=19456,t=1,p=1', '$argon2id$v=19$m=19456,t=2,p=0', '$argon2id$v=19$m=999999999,t=2,p=1', '$argon2id$v=19$m=19456,t=9999999,p=1']) {
    assert.equal(inspectArgon2idHash(header + '$' + salt + '$' + digest), null)
  }
  assert.equal(inspectArgon2idHash('sha256:abc'), null)
  assert.equal(inspectArgon2idHash(null), null)
})
