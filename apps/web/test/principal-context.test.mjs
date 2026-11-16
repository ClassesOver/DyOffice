import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { canReadPersonalFiles, principalContext } from '../server/auth/principal.mjs'

const deploymentId = randomUUID()
const userId = randomUUID()
const otherId = randomUUID()
const sessionId = randomUUID()

test('principal context keeps the session owner and rejects client-shaped roles', () => {
  const principal = principalContext({
    deploymentId, userId, sessionId, roles: ['config_admin', 'user'], authVersion: '3',
  })
  assert.equal(principal.ownerId, userId)
  assert.equal(principal.authVersion, '3')
  assert.deepEqual(principal.roles, ['config_admin', 'user'])
  assert.equal(principalContext({ deploymentId, userId, sessionId, roles: ['owner'] }), null)
  assert.equal(principalContext({ deploymentId, userId: 'me', sessionId, roles: ['user'] }), null)
})

test('a config admin cannot read another account personal files', () => {
  const admin = principalContext({ deploymentId, userId, sessionId, roles: ['config_admin'], authVersion: '1' })
  const owner = principalContext({ deploymentId, userId: otherId, sessionId: randomUUID(), roles: ['user'], authVersion: '1' })
  assert.equal(canReadPersonalFiles(admin, otherId), false)
  assert.equal(canReadPersonalFiles(admin, userId), true)
  assert.equal(canReadPersonalFiles(owner, otherId), true)
  assert.equal(canReadPersonalFiles(owner, userId), false)
  assert.equal(canReadPersonalFiles(admin, 'not-a-user'), false)
})
