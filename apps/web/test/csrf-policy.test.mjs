import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createCsrfPolicy } from '../server/auth/csrf-policy.mjs'

const secret = randomBytes(32)
const principal = Object.freeze({ sessionId: randomUUID(), deploymentId: randomUUID() })
const origin = 'https://office.example.test'
const csrf = createCsrfPolicy({ secret, trustedOrigin: origin })

function request(token, requestOrigin = origin) {
  return {
    headers: { origin: requestOrigin, 'x-dyoffice-csrf': token, host: 'evil.example.test' },
    rawHeaders: ['Origin', requestOrigin, 'X-DyOffice-CSRF', token],
  }
}

test('session-bound CSRF token validates exact trusted Origin and does not trust Host', () => {
  const token = csrf.issue(principal)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(csrf.verify(request(token), principal), true)
  assert.equal(csrf.verify(request(token, 'https://office.example.test.evil.test'), principal), false)
  assert.equal(csrf.verify(request(token, 'https://admin.example.test'), principal), false)
  assert.equal(csrf.verify(request(token, 'null'), principal), false)
  assert.equal(csrf.verify(request(token, undefined), principal), true)
  assert.equal(csrf.verify({ headers: {'x-dyoffice-csrf':token} }, principal), false)
})

test('tokens are not reusable in another session, deployment or secret rotation', () => {
  const token = csrf.issue(principal)
  assert.equal(csrf.verify(request(token), { ...principal, sessionId: randomUUID() }), false)
  assert.equal(csrf.verify(request(token), { ...principal, deploymentId: randomUUID() }), false)
  const rotated = createCsrfPolicy({ trustedOrigin: origin, secret: randomBytes(32) })
  assert.equal(rotated.verify(request(token), principal), false)
  assert.equal(csrf.verify(request(token), null), false)
  assert.throws(() => csrf.issue({sessionId:'invalid',deploymentId:principal.deploymentId}), TypeError)
})

test('malformed tokens and duplicate Origin/CSRF headers fail closed', () => {
  const token = csrf.issue(principal)
  for (const invalid of [token.slice(1), token + 'a', 'a'.repeat(43), '', '!!!', undefined]) {
    assert.equal(csrf.verify(request(invalid), principal), false)
  }
  const duplicateOrigin = request(token)
  duplicateOrigin.rawHeaders.push('origin', origin)
  assert.equal(csrf.verify(duplicateOrigin, principal), false)
  const duplicateToken = request(token)
  duplicateToken.rawHeaders.push('X-DyOffice-CSRF', token)
  assert.equal(csrf.verify(duplicateToken, principal), false)
  const distinct = request(token)
  distinct.headersDistinct = { origin: [origin, origin] }
  assert.equal(csrf.verify(distinct, principal), false)
})

test('CSRF signing key and origin configuration must be production-safe', () => {
  assert.throws(() => createCsrfPolicy({ secret: Buffer.alloc(16), trustedOrigin: origin }), TypeError)
  assert.throws(() => createCsrfPolicy({ secret:'hardcoded-password', trustedOrigin: origin }), TypeError)
  for (const badOrigin of ['http://office.example.test','https://office.example.test/path',
    'https://a:pass@office.example.test', 'https://office.example.test?x=1',
    'https://office.example.test/', 'javascript:alert(1)']) {
    assert.throws(() => createCsrfPolicy({secret,trustedOrigin:badOrigin}), TypeError, badOrigin)
  }
  const local = createCsrfPolicy({secret,trustedOrigin:'http://127.0.0.1:3080'})
  const localToken = local.issue(principal)
  assert.equal(local.verify(request(localToken,'http://127.0.0.1:3080'),principal),true)
})
