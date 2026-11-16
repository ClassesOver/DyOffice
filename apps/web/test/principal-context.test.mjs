import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server/src/app.mjs'
import { withPrincipalTransaction } from '../server/db/context.mjs'
import { createAuthorizer } from '../server/src/modules/policy/authorize.mjs'
import { principalFromSession, devPrincipalFor } from '../server/src/modules/policy/principal.mjs'

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEPLOYMENT = '11111111-1111-4111-8111-111111111111'

function actor(userId, roles = ['user']) {
  return {
    userId,
    ownerId: userId,
    deploymentId: DEPLOYMENT,
    sessionId: '33333333-3333-4333-8333-333333333333',
    roles,
    source: 'session',
  }
}

function scriptedPool(lookup) {
  const calls = []
  return {
    calls,
    async connect() {
      return {
        async query(sql, params) {
          calls.push({ sql, params })
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) {
            return { rows: [], rowCount: 0 }
          }
          if (sql.includes('rolsuper')) {
            return {
              rows: [{
                rolname: 'dyoffice_app',
                rolsuper: false,
                rolbypassrls: false,
                rolcreatedb: false,
                rolcreaterole: false,
                owns_files: false,
                relrowsecurity: true,
                relforcerowsecurity: true,
              }],
              rowCount: 1,
            }
          }
          if (sql.includes('set_config')) return { rows: [{}], rowCount: 1 }
          return lookup(sql, params)
        },
        release() {},
      }
    },
  }
}

test('session principal uses the session user and ignores a supplied owner', () => {
  const principal = principalFromSession({
    userId: USER_A,
    ownerId: USER_B,
    deploymentId: DEPLOYMENT,
    sessionId: '33333333-3333-4333-8333-333333333333',
    roles: ['config_admin'],
  })
  assert.equal(principal.userId, USER_A)
  assert.equal(principal.ownerId, USER_A)
  assert.deepEqual(principal.roles, ['config_admin'])
  assert.equal(principal.source, 'session')
  assert.equal(principalFromSession(null), null)
  assert.equal(devPrincipalFor('personal').ownerId, 'dev-personal')
  assert.deepEqual(devPrincipalFor('admin').roles, ['config_admin'])
})

test('principal transaction sets local identity and rolls back on failure', async () => {
  const pool = scriptedPool(() => { throw new Error('sql failed') })
  await assert.rejects(
    withPrincipalTransaction(pool, actor(USER_A), async () => { throw new Error('boom') }),
    /boom/,
  )
  const text = pool.calls.map((call) => call.sql).join('\n')
  assert.match(text, /SET LOCAL ROLE dyoffice_app/)
  assert.match(text, /set_config\('app\.current_user', \$1, true\)/)
  assert.match(text, /set_config\('app\.current_deployment', \$2, true\)/)
  assert.match(text, /set_config\('app\.current_session', \$3, true\)/)
  assert.doesNotMatch(text, /SET\s+app\.current_user/i)
  assert.equal(pool.calls.some((call) => call.sql === 'ROLLBACK'), true)
  assert.equal(pool.calls.some((call) => call.sql === 'COMMIT'), false)
  const setting = pool.calls.find((call) => call.sql.includes('set_config'))
  assert.deepEqual(setting.params, [USER_A, DEPLOYMENT, actor(USER_A).sessionId])

  const source = await readFile(new URL('../server/db/context.mjs', import.meta.url), 'utf8')
  assert.match(source, /set_config\('app\.current_user', \$1, true\)/)
  assert.doesNotMatch(source, /SET\s+app\.current_user/i)
})

test('authorize denies another owner, an admin role, and a missing artifact the same way', async () => {
  const pool = scriptedPool(() => ({ rows: [], rowCount: 0 }))
  const authorize = createAuthorizer(pool)
  const id = randomUUID()
  const missing = await assert.rejects(
    authorize(actor(USER_A), 'file:read', { id: randomUUID() }),
    (error) => error.code === 'NOT_FOUND' && error.message === '文件不存在',
  )
  assert.equal(missing, undefined)
  await assert.rejects(
    authorize(actor(USER_B, ['config_admin']), 'job:enqueue', { artifactId: id }),
    (error) => error.code === 'NOT_FOUND' && error.message === '文件不存在',
  )
  await assert.rejects(
    authorize(actor(USER_B), 'job:cancel', { artifactId: id, ownerId: USER_A, role: 'config_admin' }),
    (error) => error.code === 'NOT_FOUND',
  )
  assert.equal(pool.calls.some((call) => call.sql.includes('config_admin')), false)
  assert.equal(pool.calls.some((call) => String(call.params || '').includes(USER_A) && call.sql.includes('UNION ALL') === false && call.sql.includes('owner')), false)
  const before = pool.calls.length
  await assert.rejects(
    authorize(actor(USER_B), 'file:read', { id, ownerId: USER_A }),
    (error) => error.code === 'NOT_FOUND',
  )
  assert.equal(pool.calls.length, before)
  pool.calls.length = 0
  const visible = scriptedPool(() => ({ rows: [{ id }], rowCount: 1 }))
  await createAuthorizer(visible)(actor(USER_A, ['config_admin']), 'job:enqueue', { artifactId: id })
  assert.equal(visible.calls.some((call) => call.sql.includes('config_admin')), false)
  assert.equal(visible.calls.some((call) => call.sql.includes('UNION ALL')), true)
})

test('Fastify attaches the dev principal and a session principal, and ignores caller owner fields', async () => {
  const legacy = await buildApp({
    env: 'test',
    logger: false,
    rateLimit: { max: 20, windowMs: 60_000 },
    readyCheck: async () => true,
    legacy: {
      serveStatic() {},
      store: { read() { return { files: [], preferences: {} } } },
      credentials: { userToken: 'personal-secret', adminToken: 'admin-secret' },
    },
  })
  let seen
  legacy.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/v1/capabilities')) seen = request.principal
  })
  const personal = await legacy.inject({
    method: 'GET',
    url: '/api/v1/capabilities',
    headers: { authorization: 'Bearer personal-secret', 'x-owner-id': USER_B, 'x-user-id': USER_B },
  })
  assert.equal(personal.statusCode, 200)
  assert.equal(seen.ownerId, 'dev-personal')
  assert.equal(seen.userId, 'dev-personal')
  assert.deepEqual(seen.roles, ['user'])
  const admin = await legacy.inject({
    method: 'GET',
    url: '/api/preferences',
    headers: { authorization: 'Bearer admin-secret' },
  })
  assert.equal(admin.statusCode, 403)
  await legacy.close()

  const sessionApp = await buildApp({
    env: 'test',
    logger: false,
    rateLimit: { max: 20, windowMs: 60_000 },
    readyCheck: async () => true,
    auth: {
      async authenticate(request) {
        if (request.headers['x-fail'] === '1') throw new Error('database password=secret')
        if (request.headers.authorization === 'Bearer personal-secret') return null
        if (request.headers['x-user'] !== 'a') return null
        return {
          userId: USER_A,
          ownerId: USER_B,
          deploymentId: DEPLOYMENT,
          sessionId: '33333333-3333-4333-8333-333333333333',
          roles: ['config_admin'],
        }
      },
    },
  })
  sessionApp.get('/api/v1/who', async (request) => ({
    ownerId: request.principal.ownerId,
    roles: request.principal.roles,
    source: request.principal.source,
  }))
  const who = await sessionApp.inject({ method: 'GET', url: '/api/v1/who', headers: { 'x-user': 'a', 'x-owner-id': USER_B } })
  assert.equal(who.statusCode, 200)
  assert.deepEqual(who.json(), { ownerId: USER_A, roles: ['config_admin'], source: 'session' })
  const bearer = await sessionApp.inject({
    method: 'GET',
    url: '/api/v1/who',
    headers: { authorization: 'Bearer personal-secret' },
  })
  assert.equal(bearer.statusCode, 401)
  assert.equal(bearer.json().error, '请登录')
  const broken = await sessionApp.inject({ method: 'GET', url: '/api/v1/who', headers: { 'x-fail': '1' } })
  assert.equal(broken.statusCode, 503)
  assert.equal(JSON.stringify(broken.json()).includes('password'), false)
  await sessionApp.close()
})
