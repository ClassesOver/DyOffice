import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeDevApi, identifyDevPrincipal, isPersonalResource } from '../server/request-boundary.mjs'

const credentials = { userToken: 'personal-secret', adminToken: 'admin-secret' }
const headers = (value, variants) => ({
  headers: { authorization: value },
  rawHeaders: variants ?? ['Authorization', value],
  headersDistinct: { authorization: [value] },
})

test('only a single correctly formed Bearer credential is accepted', () => {
  assert.equal(identifyDevPrincipal(headers('Bearer personal-secret'), credentials), 'personal')
  assert.equal(identifyDevPrincipal(headers('Bearer admin-secret'), credentials), 'admin')
  for (const value of ['personal-secret', 'Basic personal-secret', 'Bearer personal-secret extra', 'Bearer personal-secret,admin-secret', 'Bearer  personal-secret', 'Bearer wrong']) {
    assert.equal(identifyDevPrincipal(headers(value), credentials), null, value)
  }
  assert.equal(identifyDevPrincipal(headers('Bearer personal-secret', ['Authorization', 'Bearer personal-secret', 'Authorization', 'Bearer admin-secret']), credentials), null)
  assert.equal(identifyDevPrincipal({ headers: { authorization: 'Bearer personal-secret' }, headersDistinct: { authorization: ['Bearer personal-secret', 'Bearer admin-secret'] } }, credentials), null)
  assert.equal(identifyDevPrincipal({ headers: {} }, credentials), null)
})

test('admin does not inherit personal files or preferences and personal cannot edit admin config', () => {
  assert.deepEqual(authorizeDevApi(headers('Bearer admin-secret'), credentials, '/api/v1/files/abc'), { status: 403, error: '需要个人工作区权限' })
  assert.deepEqual(authorizeDevApi(headers('Bearer admin-secret'), credentials, '/api/v1/objects/00000000-0000-4000-8000-000000000000'), { status: 403, error: '需要个人工作区权限' })
  assert.deepEqual(authorizeDevApi(headers('Bearer admin-secret'), credentials, '/api/v1/files'), { status: 403, error: '需要个人工作区权限' })
  assert.deepEqual(authorizeDevApi(headers('Bearer admin-secret'), credentials, '/api/preferences'), { status: 403, error: '需要个人工作区权限' })
  assert.deepEqual(authorizeDevApi(headers('Bearer personal-secret'), credentials, '/api/admin/config'), { status: 403, error: '需要管理员权限' })
  assert.deepEqual(authorizeDevApi(headers('Bearer personal-secret'), credentials, '/api/v1/files/abc'), { principal: 'personal' })
  assert.deepEqual(authorizeDevApi(headers('Bearer admin-secret'), credentials, '/api/admin/config'), { principal: 'admin' })
  assert.deepEqual(authorizeDevApi(headers('invalid'), credentials, '/api/models'), { status: 401, error: '请登录' })
  assert.equal(isPersonalResource('/api/v1/health/live'), false)
})
